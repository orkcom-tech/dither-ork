## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

<!-- What you ran, and what you looked at. Screenshots for anything visual. -->

- [ ] `docker compose exec -T web sh -c 'npm run typecheck'`
- [ ] `docker compose exec -T web sh -c 'npm test -- --run'`
- [ ] `docker compose run --rm --entrypoint bash wasm -c 'cd /app/core && cargo test --all'`
- [ ] `cargo fmt` and `cargo clippy --all-targets -- -D warnings` clean (only if `core/` changed)

## Notes

- [ ] New behaviour has a test
- [ ] No mocks, stubs or placeholder content — anything that could not be done
      is left out and said so below
- [ ] If an effect was added or removed, the counts in
      `web/src/registry/catalogue.test.ts` are updated in this commit

<!-- Anything deliberately left out, and why. -->
