# Supplier Onboarding v1: remaining journey gaps

The supplier now submits after Supply & declaration and sees a receipt. Extraction, checks and the report run for the buyer after submission. These are the next supplier experience gaps to address, in priority order.

1. **Resuming a long form is fragile.** The supplier session lasts one hour and the one-time link is consumed at redemption. Answers and files are saved when the supplier selects Continue, but current-step edits are lost if the session expires or the browser closes. Add an authenticated resume path and periodic draft saving without weakening the one-time link or CSRF controls.
2. **The final step lacks a compact submission inventory.** It offers declarations but no concise list of answers and uploaded documents. Add a non-verification summary within the final step, with links back to each section, so suppliers can correct accidental omissions before the irreversible Submit action. Keep provider results exclusively in the buyer Case Manager.
3. **Document management is limited.** Each field now confirms that a file was uploaded, but it does not show the stored filename, upload date, replacement history, or an explicit remove action. Provide a secure document inventory and replacement/remove controls. Make clear that presence alone does not confirm authenticity or adequacy.
4. **Privacy and help information is generic.** The form asks the supplier to contact the buyer for a privacy notice and help. Add buyer-configured privacy-notice and support links, validated as HTTPS URLs, with a default KYCProbe support path when no buyer contact is configured.
5. **Confirmation is browser-only if mail delivery fails.** The receipt is durable, but the optional confirmation email is best effort. Add a monitored retry path and show a buyer-visible delivery status without exposing supplier data through the supplier API.

The form must continue to reject sample-only declarations and require actual authority, accuracy, and screening consent for a real submission. Watermarked test evidence can exercise the pipeline but cannot establish a genuine verification pass.
