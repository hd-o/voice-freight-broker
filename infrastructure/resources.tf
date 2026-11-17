locals {
  administrators = toset([for email in var.administrators : lower(trimspace(email))])
  reviewers      = toset([for email in var.reviewers : lower(trimspace(email))])
}

resource "cloudflare_d1_database" "hosting" {
  account_id = var.account_id
  name       = "voice-freight-prod"
  lifecycle {
    prevent_destroy = true
  }
}

# Consumers and bindings belong to Wrangler; Terraform owns queue existence.
resource "cloudflare_queue" "analysis" {
  for_each   = toset(["analysis", "analysis-dead-letter"])
  account_id = var.account_id
  queue_name = "voice-freight-${each.key}"
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "email" {
  count      = var.identity_provider_id == null ? 1 : 0
  account_id = var.account_id
  name       = "Voice Freight email code"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_application" "api" {
  account_id                 = var.account_id
  name                       = "voice-freight API"
  type                       = "self_hosted"
  domain                     = "${trimprefix(var.origin, "https://")}/api"
  session_duration           = "8h"
  allowed_idps               = [var.identity_provider_id != null ? var.identity_provider_id : cloudflare_zero_trust_access_identity_provider.email[0].id]
  auto_redirect_to_identity  = true
  app_launcher_visible       = false
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  policies = [{
    name       = "Invited demo users"
    decision   = "allow"
    precedence = 1
    include    = [for email in setunion(local.administrators, local.reviewers) : { email = { email = email } }]
  }]
  lifecycle {
    precondition {
      condition     = length(setintersection(local.administrators, local.reviewers)) == 0
      error_message = "Administrator and reviewer emails must not overlap."
    }
  }
}
