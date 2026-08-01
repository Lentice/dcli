# opencode resume

Continue a completed job. Requires an explicit kind:

  dcli-opencode resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
  dcli-opencode resume <job-id> --kind fork_from_artifacts --hard-timeout-sec <n>
  dcli-opencode resume <job-id> --kind retry_attempt --hard-timeout-sec <n>

Synchronous resume also needs a finite outer caller timeout; use submit
plus bounded wait when the caller cannot set one.
Use exact wrapper lineage. Never "continue last session".
