# Remaining work

The implemented package behavior is documented in [`packages/pi-git-workflow/README.md`](../packages/pi-git-workflow/README.md). Shared Git automation practices are documented in [`git.md`](git.md), with the security boundary summarized in [`security-invariants.md`](security-invariants.md).

1. Add explicit unit coverage for:
   - a candidate ref disappearing between inspection and deletion;
   - Git commands timing out or returning a killed result; and
   - an upstream-present branch being retained by automatic cleanup.
2. Review the final diff for accidental target-preparation, checkout, remote-deletion, force-deletion, or reload behavior.
3. Run final verification after all code and documentation edits:

   ```bash
   vp test packages/pi-git-workflow/tests
   vp check --fix
   vp run format:changelog
   vp run validate
   ```

4. Resolve any failures, then prepare the changes for review.
