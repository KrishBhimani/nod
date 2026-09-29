# E2B computers (optional)

E2B is an optional computer provider: one sandbox per owner, with browser (`otto-browser`), workspace (`node`) and connected CLI (`otto-connected`) under separate Linux users and a root-installed nftables guard. Cloudflare is the selected hosted provider.

```sh
node --import tsx deployment/e2b/build.ts computer --check                   # offline context check
node --import tsx deployment/e2b/build-local.ts                              # local image
node deployment/e2b/validate-computer.mjs otto-e2b-computer:<hash-prefix>    # isolation checks
node --env-file=<private-dev-env> --import tsx deployment/e2b/build.ts computer <template-name>  # billable
```

Select it with `COMPUTER_PROVIDER=e2b`, `OBJECT_STORAGE_PROVIDER=postgres`, `E2B_API_KEY` and the returned template ID as `E2B_COMPUTER_TEMPLATE`. Live acceptance (`deployment/e2b/acceptance.ts plan|run|inspect|cleanup`) creates a disposable development sandbox and must pass before enabling E2B anywhere.
