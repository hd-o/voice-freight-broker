variable "account_id" {
  type        = string
  description = "Deployed Cloudflare account ID."
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Use the 32-character Cloudflare account ID."
  }
}

variable "origin" {
  type        = string
  description = "Public HTTPS origin, without a path or trailing slash. Configure a custom-domain route separately if used."
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.origin))
    error_message = "Use an HTTPS hostname without a path or trailing slash."
  }
}

variable "access_team_domain" {
  type        = string
  description = "Existing Zero Trust team hostname, for example client.cloudflareaccess.com."
  validation {
    condition     = can(regex("^[a-z0-9-]+\\.cloudflareaccess\\.com$", var.access_team_domain))
    error_message = "Use the team's cloudflareaccess.com hostname."
  }
}

variable "identity_provider_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Reuse an existing Access identity provider; null creates an email-code provider."
}

variable "administrators" {
  type        = set(string)
  description = "Initial application administrator emails."
  validation {
    condition     = length(var.administrators) > 0 && alltrue([for email in var.administrators : can(regex("^[^@ ,]+@[^@ ,]+\\.[^@ ,]+$", email))])
    error_message = "Provide at least one administrator email."
  }
}

variable "reviewers" {
  type        = set(string)
  default     = []
  description = "Application reviewer emails; must not overlap administrators."
  validation {
    condition     = alltrue([for email in var.reviewers : can(regex("^[^@ ,]+@[^@ ,]+\\.[^@ ,]+$", email))])
    error_message = "Provide valid reviewer emails."
  }
}

variable "bootstrap" {
  type        = bool
  default     = false
  description = "First installation only: publish the Tools placeholder and initialize API."
}

variable "secret_revision" {
  type        = string
  default     = "1"
  description = "Change to upload a new production provider secret."
}

variable "zone_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Cloudflare zone ID when the origin uses a custom domain."
}
