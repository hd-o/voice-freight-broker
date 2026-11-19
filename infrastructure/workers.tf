locals {
  api_name       = "voice-freight-api"
  tools_name     = "voice-freight-tools"
  app_name       = "app"
  api_bundle     = abspath("${path.module}/../apps/api/dist/worker.js")
  tools_bundle   = abspath("${path.module}/../apps/tools/${var.bootstrap ? "dist-bootstrap" : "dist"}/worker.js")
  app_bundle     = abspath("${path.module}/../apps/web/dist-gateway/worker.js")
  app_assets     = abspath("${path.module}/../apps/web/dist/client")
  app_assets_tag = sha256(jsonencode({ for file in sort(tolist(fileset(local.app_assets, "**"))) : file => filesha256("${local.app_assets}/${file}") }))
  migration_path = "${path.module}/../packages/backend/migrations"
  configuration = {
    accountId      = var.account_id
    databaseId     = cloudflare_d1_database.hosting.id
    databaseName   = cloudflare_d1_database.hosting.name
    administrators = sort(tolist(local.administrators))
    reviewers      = sort(tolist(local.reviewers))
    apiWorkerName  = local.api_name
  }
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      persist            = true
      head_sampling_rate = 1
      invocation_logs    = false
    }
    traces = {
      enabled            = true
      persist            = true
      head_sampling_rate = 1
    }
  }
}

resource "terraform_data" "migrations" {
  triggers_replace = [
    cloudflare_d1_database.hosting.id,
    sha256(join("", [for file in sort(tolist(fileset(local.migration_path, "*.sql"))) : "${file}:${filesha256("${local.migration_path}/${file}")}"])),
  ]

  provisioner "local-exec" {
    command     = "pnpm --silent cli deployed database migrate --configuration-env HOSTING_CONFIGURATION --json"
    working_dir = abspath("${path.module}/..")
    environment = { HOSTING_CONFIGURATION = jsonencode(local.configuration) }
  }
}

resource "terraform_data" "roles" {
  triggers_replace = [cloudflare_d1_database.hosting.id, sha256(jsonencode([local.administrators, local.reviewers]))]
  depends_on       = [terraform_data.migrations]

  provisioner "local-exec" {
    command     = "pnpm --silent cli deployed roles sync --configuration-env HOSTING_CONFIGURATION --json"
    working_dir = abspath("${path.module}/..")
    environment = { HOSTING_CONFIGURATION = jsonencode(local.configuration) }
  }
}

resource "cloudflare_workers_script" "tools" {
  account_id          = var.account_id
  script_name         = local.tools_name
  content_file        = local.tools_bundle
  content_sha256      = filesha256(local.tools_bundle)
  main_module         = "worker.js"
  compatibility_date  = "2026-11-12"
  compatibility_flags = ["nodejs_compat"]
  force               = true
  observability       = local.observability
  bindings = [for binding in [
    { type = "d1", name = "DB", database_id = cloudflare_d1_database.hosting.id },
    { type = "durable_object_namespace", name = "CALLS", class_name = "LiveCall", script_name = local.api_name },
    { type = "queue", name = "ANALYSIS_QUEUE", queue_name = cloudflare_queue.analysis["analysis"].queue_name },
    { type = "queue", name = "ANALYSIS_DEAD_LETTER", queue_name = cloudflare_queue.analysis["analysis-dead-letter"].queue_name },
    { type = "service", name = "ANALYSIS_PROVIDER", service = local.api_name, entrypoint = "AnalysisProvider" },
    { type = "service", name = "CONFIRMATION_PROVIDER", service = local.api_name, entrypoint = "ConfirmationProvider" },
  ] : binding if !var.bootstrap]
  depends_on = [terraform_data.migrations]
}

resource "cloudflare_workers_script" "api" {
  account_id          = var.account_id
  script_name         = local.api_name
  content_file        = local.api_bundle
  content_sha256      = filesha256(local.api_bundle)
  main_module         = "worker.js"
  compatibility_date  = "2026-11-12"
  compatibility_flags = ["nodejs_compat"]
  force               = true
  keep_bindings       = ["secret_text"]
  observability       = local.observability
  migrations          = var.bootstrap ? { new_tag = "v1", new_sqlite_classes = ["LiveCall"] } : null
  bindings = [
    { type = "d1", name = "DB", database_id = cloudflare_d1_database.hosting.id },
    { type = "durable_object_namespace", name = "CALLS", class_name = "LiveCall" },
    { type = "service", name = "TOOLS", service = cloudflare_workers_script.tools.script_name, entrypoint = "Tools" },
    { type = "plain_text", name = "ENVIRONMENT", text = "prod" },
    { type = "plain_text", name = "AUTH_MODE", text = "access" },
    { type = "plain_text", name = "PUBLIC_ORIGIN", text = var.origin },
    { type = "plain_text", name = "ACCESS_ISSUER", text = "https://${var.access_team_domain}" },
    { type = "plain_text", name = "ACCESS_AUDIENCE", text = cloudflare_zero_trust_access_application.api.aud },
    { type = "plain_text", name = "VOICE_PROVIDER", text = "openai" },
  ]
}

resource "terraform_data" "secret" {
  triggers_replace = [var.account_id, cloudflare_workers_script.api.id, var.secret_revision]

  provisioner "local-exec" {
    command     = "pnpm --silent cli deployed secrets sync --configuration-env HOSTING_CONFIGURATION --json"
    working_dir = abspath("${path.module}/..")
    environment = { HOSTING_CONFIGURATION = jsonencode(local.configuration) }
  }
}

resource "cloudflare_workers_script" "app" {
  count              = var.bootstrap ? 0 : 1
  account_id         = var.account_id
  script_name        = local.app_name
  content_file       = local.app_bundle
  content_sha256     = filesha256(local.app_bundle)
  main_module        = "worker.js"
  compatibility_date = "2026-11-12"
  force              = true

  # The provider detects asset changes after planning computed fields.
  # Tagging the manifest makes its changed etag unknown before apply.
  annotations = { workers_tag = local.app_assets_tag }
  assets = {
    directory = local.app_assets
    config = {
      not_found_handling = "404-page"
      run_worker_first   = ["/api", "/api/*", "/auth/*"]
    }
  }
  bindings = [
    { type = "assets", name = "ASSETS" },
    { type = "service", name = "API", service = cloudflare_workers_script.api.script_name },
    { type = "plain_text", name = "AUTH_MODE", text = "access" },
    { type = "plain_text", name = "PUBLIC_ORIGIN", text = var.origin },
  ]
  depends_on = [terraform_data.roles, terraform_data.secret]
}

resource "cloudflare_workers_script_subdomain" "api" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.api.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_script_subdomain" "tools" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.tools.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_script_subdomain" "app" {
  count            = var.bootstrap ? 0 : 1
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.app[0].script_name
  enabled          = var.zone_id == null
  previews_enabled = false
}

resource "cloudflare_workers_custom_domain" "app" {
  count            = !var.bootstrap && var.zone_id != null ? 1 : 0
  account_id       = var.account_id
  hostname         = trimprefix(var.origin, "https://")
  service          = cloudflare_workers_script.app[0].script_name
  zone_id          = var.zone_id
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_queue_consumer" "analysis" {
  count             = var.bootstrap ? 0 : 1
  account_id        = var.account_id
  queue_id          = cloudflare_queue.analysis["analysis"].id
  script_name       = cloudflare_workers_script.tools.script_name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.analysis["analysis-dead-letter"].queue_name
  settings          = { batch_size = 1, max_retries = 5, retry_delay = 30 }
  depends_on        = [terraform_data.secret]
}

resource "cloudflare_queue_consumer" "dead_letter" {
  count       = var.bootstrap ? 0 : 1
  account_id  = var.account_id
  queue_id    = cloudflare_queue.analysis["analysis-dead-letter"].id
  script_name = cloudflare_workers_script.tools.script_name
  type        = "worker"
  settings    = { batch_size = 1 }
  depends_on  = [terraform_data.secret]
}
