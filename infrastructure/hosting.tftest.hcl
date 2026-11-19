mock_provider "cloudflare" {}

variables {
  account_id         = "0123456789abcdef0123456789abcdef"
  origin             = "https://freight.example.com"
  access_team_domain = "client.cloudflareaccess.com"
  administrators     = ["Admin@example.com"]
  reviewers          = ["reviewer@example.com"]
}

run "hosting" {
  command = plan

  assert {
    condition     = cloudflare_d1_database.hosting.name == "voice-freight-prod"
    error_message = "The database name must match the committed Wrangler bindings."
  }
  assert {
    condition     = cloudflare_queue.analysis["analysis-dead-letter"].queue_name == "voice-freight-analysis-dead-letter"
    error_message = "The dead-letter queue name must match the committed Wrangler bindings."
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.api.domain == "freight.example.com/api" && length(cloudflare_zero_trust_access_application.api.policies[0].include) == 2
    error_message = "Access must protect the API and include both invited roles."
  }
  assert {
    condition     = output.hosting.administrators == tolist(["admin@example.com"])
    error_message = "Application identities must be normalized."
  }
  assert {
    condition = alltrue([
      for worker in [cloudflare_workers_script.api, cloudflare_workers_script.tools] :
      worker.observability.head_sampling_rate == 1 &&
      worker.observability.logs.head_sampling_rate == 1 &&
      worker.observability.logs.persist &&
      worker.observability.traces.head_sampling_rate == 0.1 &&
      worker.observability.traces.persist
    ])
    error_message = "Trace sampling must leave application logs fully sampled."
  }
}

run "trace_sampling_override" {
  command = plan
  variables {
    trace_sampling_rate = 0.5
  }
  assert {
    condition = alltrue([
      for worker in [cloudflare_workers_script.api, cloudflare_workers_script.tools] :
      worker.observability.traces.head_sampling_rate == 0.5 && worker.observability.logs.head_sampling_rate == 1
    ])
    error_message = "The trace sampling override must apply without changing log sampling."
  }
}

run "invalid_trace_sampling" {
  command = plan
  variables {
    trace_sampling_rate = 1.1
  }
  expect_failures = [var.trace_sampling_rate]
}

run "overlapping_roles" {
  command = plan
  variables {
    reviewers = ["admin@example.com"]
  }
  expect_failures = [cloudflare_zero_trust_access_application.api]
}
