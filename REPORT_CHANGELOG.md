# Report Changelog

## Updated Deliverables

- Rebuilt `VDT26_Dinh_Quyet_Thang_Bao_cao.docx`.
- Rewrote `generate_report.py` so the DOCX is generated from project-specific content instead of generic prompt text.

## Main Content Changes

- Removed generic technology claims that were not supported by the repo, including FastAPI, Pandas, MongoDB, Newman and REST Assured.
- Reframed the project as an API/backend regression-testing PoC for Medusa REST APIs.
- Added concrete implemented modules: logging middleware, ELK path, log-ingestion, behavior-engine, golden oracle, script-generator, test-runner/reporting, dashboard/HITL and PostgreSQL/MinIO storage.
- Added clear distinctions between implemented work, demo/PoC scope and future work.
- Added PostgreSQL and MinIO snapshots from the running local stack.
- Added two storage diagrams to the DOCX:
  - PostgreSQL platform storage ERD.
  - MinIO `platwright` bucket artifact layout.
- Added real demo metrics from MinIO reports and validation artifacts:
  - 18 behavior candidates.
  - 9 approved generated specs.
  - 56 golden schemas.
  - Latest regression run: 9/9 passed.
  - 295 invariant rows in PostgreSQL.
  - Latest mutation evaluation: 150 mutants, 40 killed, 5 survived, 105 inconclusive, 88.9% mutation score on measurable mutants.
- Clarified that traffic is synthetic/demo traffic, not production traffic.
- Clarified that LLM is not on the deterministic pass/fail path.

## How To Regenerate

```bash
/Users/thangdq/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 generate_report.py
```
