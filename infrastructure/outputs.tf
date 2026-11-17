# The deployment script consumes this public configuration contract.
output "hosting" {
  value = {
    accountId      = var.account_id
    origin         = var.origin
    prefix         = var.prefix
    databaseId     = cloudflare_d1_database.hosting.id
    databaseName   = cloudflare_d1_database.hosting.name
    issuer         = "https://${var.access_team_domain}"
    audience       = cloudflare_zero_trust_access_application.api.aud
    administrators = sort(tolist(local.administrators))
    reviewers      = sort(tolist(local.reviewers))
  }
}
