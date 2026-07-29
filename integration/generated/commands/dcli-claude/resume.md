# claude resume

Continue a completed job. Requires an explicit kind:

  dcli-claude resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
  dcli-claude resume <job-id> --kind fork_from_artifacts --hard-timeout-sec <n>
  dcli-claude resume <job-id> --kind retry_attempt --hard-timeout-sec <n>

Use exact wrapper lineage. Never "continue last session".
