terraform {
  required_version = ">= 1.12, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.29.0"
    }
  }
  backend "s3" {
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
    use_lockfile                = true
  }
}

provider "cloudflare" {}

variable "account_id" {
  type = string
}

resource "cloudflare_r2_bucket" "state" {
  account_id = var.account_id
  name       = "voice-freight-terraform-state"

  lifecycle {
    prevent_destroy = true
  }
}
