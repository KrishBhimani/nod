---
name: sign-in
description: Sign in to a website in the private browser without handling secrets. Use when a page asks for a login, a code, or when account data on a website is needed.
---

# Sign in

1. Open the site in the browser, then call sign_in inspect.
2. If several methods are listed and the user has not chosen, ask which one with ask_user, including methods that need their device. Honor a method the user already named. Site-selected defaults are not user choices. Call sign_in select_method with the exact origin and methodId, then inspect the result. Resolve each new group separately: choosing Chave Móvel Digital does not choose between Telemóvel and Código QR. Continue is a navigation action, not an alternative method.
3. Call sign_in request with the exact origin, a short label, the observed step kind (identifier, password or otp) and selectors. The server reuses a uniquely matching saved login for that exact origin or opens a private Vault form. A PIN is a reusable password and belongs in Vault. For a one-time code, the server first tries the connected owned mailbox when the page identifies an email challenge; otherwise it creates a secure code request in chat. Let the server send that invitation and pause the turn. Do not request or retrieve codes yourself.
4. After resuming, snapshot the page to confirm the sign-in worked. Submission is not proof.
5. Never ask for passwords, PINs, login identifiers, codes or API keys yourself and never type them with browser fill. Use sign_in request so values stay outside model context. Method questions may name NIF, EORI, Telemóvel, Cartão de Cidadão or Chave Móvel Digital without requesting their values.
6. If sign_in reports sign_in_blocked or browser_not_supported, offer browser_session connect, or ask the user to choose Take control in the browser controls, sign in, then choose Resume agent.
7. manage_apps list shows saved access: browser_session entries can be reused with browser_session use; credentials_saved entries still go through steps 1 to 4.
8. For manual_sign_in_required, explain the selected method needs the user or their device and offer private browser control. An ordinary verification-code field uses sign_in request rather than browser takeover.
