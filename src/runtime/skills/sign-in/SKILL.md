---
name: sign-in
description: Sign in to a website in the private browser without handling secrets. Use when a page asks for a login, a code, or when account data on a website is needed.
---

# Sign in

1. Open the site in the browser, then call sign_in inspect.
2. If several supported methods are listed and the user has not chosen, ask which one with ask_user. Never pick Google or another provider on their behalf. Then call sign_in select_method with the exact origin and methodId, and inspect the result.
3. Call sign_in request with the exact origin, a short label, the step kind (identifier, password or otp) and the observed selectors. The user fills the Vault form privately; the turn pauses and resumes after they finish.
4. After resuming, snapshot the page to confirm the sign-in worked. Submission is not proof.
5. Never ask for passwords, codes or API keys in chat and never type them with browser fill.
6. If sign_in reports sign_in_blocked or browser_not_supported, offer browser_session connect, or ask the user to choose Take control in the browser controls, sign in, then choose Resume agent.
7. manage_apps list shows saved access: browser_session entries can be reused with browser_session use; credentials_saved entries still go through steps 1 to 4.
