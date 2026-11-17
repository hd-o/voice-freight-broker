terraform {
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

  required_version = ">= 1.12, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.29.0"
    }
    shell = {
      source  = "terr4m/shell"
      version = "0.10.0"
    }
  }
}

# Credentials come from CLOUDFLARE_API_TOKEN, never Terraform variables/state.
provider "cloudflare" {}
