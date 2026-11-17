# Role synchronization reads this output from the applied application state.
output "hosting" {
  value = {
    accountId      = var.account_id
    origin         = var.origin
    apiWorkerName  = local.api_name
    bootstrap      = var.bootstrap
    databaseId     = cloudflare_d1_database.hosting.id
    databaseName   = cloudflare_d1_database.hosting.name
    issuer         = "https://${var.access_team_domain}"
    audience       = cloudflare_zero_trust_access_application.api.aud
    administrators = sort(tolist(local.administrators))
    reviewers      = sort(tolist(local.reviewers))
  }
}
