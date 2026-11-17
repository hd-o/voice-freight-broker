terraform {
  required_version = ">= 1.12, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.19.1"
    }
  }
}

# Credentials come from CLOUDFLARE_API_TOKEN, never Terraform variables/state.
provider "cloudflare" {}
