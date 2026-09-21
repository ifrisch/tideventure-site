# Written Information Security Plan (WISP)

**TideVenture CPA**
**Effective date:** August 5, 2026
**Last reviewed:** August 5, 2026
**Next scheduled review:** August 2027 (or upon any material change to systems or a security incident)

> Prepared to satisfy the FTC Safeguards Rule (16 C.F.R. Part 314), the Gramm-Leach-Bliley Act, and IRS guidance for tax professionals (Publication 4557, "Safeguarding Taxpayer Data"). As a firm handling information for fewer than 5,000 consumers, TideVenture CPA qualifies for the small-business accommodations under §314.6; this plan nonetheless adopts the full framework in simplified form.

---

## 1. Purpose and Scope

This plan describes the administrative, technical, and physical safeguards TideVenture CPA ("the Firm") uses to protect customer information — meaning any nonpublic personal or financial information about clients or prospective clients, in electronic or paper form, including tax return information protected by IRC §7216.

This plan covers all systems the Firm uses to collect, store, process, or transmit customer information, including the Firm's website and client portal (tideventurecpa.com), email, connected third-party services, and any Firm-controlled devices.

## 2. Designated Qualified Individual

**Isaac Frisch, CPA** (principal) is the Qualified Individual responsible for implementing, overseeing, and enforcing this plan, including approving changes to it, overseeing service providers, and leading incident response.

## 3. Information Inventory

| Data | System of record | Protection |
|---|---|---|
| Client identity & contact data, engagement terms | Client portal database (Cloudflare R2) | Encrypted in transit (TLS); access restricted to firm principal |
| Client documents (tax docs, statements) | Client portal (Cloudflare R2) | AES-256-GCM encrypted at rest with per-client derived keys; TLS in transit |
| Tax questionnaire responses | Client portal (Cloudflare R2) | AES-256-GCM encrypted at rest; TLS in transit |
| Signed engagement records | Client portal (Cloudflare R2) | Immutable records with SHA-256 document fingerprint, timestamp, IP |
| Client email correspondence | Google Workspace (Gmail) | Google account with strong password; OAuth tokens encrypted at rest |
| Accounting/invoice data | QuickBooks Online (Intuit) | OAuth-authorized connection; tokens encrypted at rest |
| Tax preparation records | Intuit tax software (e.g., ProConnect Tax Online / Lacerte / ProSeries — [CONFIRM which product]) | Cloud-hosted by Intuit if ProConnect Tax Online; locally stored with Intuit cloud backup if Lacerte/ProSeries — [CONFIRM and update] |
| Paper documents (if any) | [FILL IN location] | Returned to client at engagement end per engagement letter; locked storage while held |

## 4. Risk Assessment

The Firm assesses the reasonably foreseeable risks below and mitigates each as described. This assessment is reviewed at least annually and after any incident or material system change.

| Risk | Mitigation |
|---|---|
| Phishing / credential theft against firm email or admin accounts | MFA on admin portal (Cloudflare Access one-time PIN); strong unique passwords; skepticism protocol for unexpected requests (see §5.1) |
| Unauthorized access to client portal accounts | Minimum 10-character passwords; PBKDF2 password hashing (100,000 iterations); login rate limiting (5 attempts / 15 min); time-limited (24h) single-use account setup links; time-limited (1h) single-use password reset links |
| Interception of data in transit | HTTPS/TLS enforced site-wide with HSTS; clients directed to exchange documents via portal, not email attachments |
| Theft or exposure of stored data | Client documents and questionnaires encrypted at rest (AES-256-GCM); OAuth tokens encrypted at rest; secrets held in Cloudflare encrypted environment variables, never in code |
| Data loss (accidental deletion, corruption) | Automated nightly incremental backup to a separate storage bucket; backups are additive (deletions never propagate); manual backup on demand |
| Malicious or accidental misuse of admin access | Admin functions restricted to @tideventurecpa.com identities behind Cloudflare Access; append-only audit log of uploads, downloads, deletions, sign-ins, emails, and resets |
| Device loss/theft | See physical safeguards (§5.3): device encryption, screen lock, no local storage of client files as standing practice |
| Service provider compromise | Vendor list and oversight in §7; least-privilege OAuth scopes (e.g., Gmail limited to read + send) |

## 5. Safeguards

### 5.1 Administrative
- Only the principal has administrative access to firm systems. No shared accounts.
- Client information is used solely to deliver engaged services (IRC §7216); any other use or disclosure requires the client's specific written consent.
- Verification protocol: unexpected requests to change a client's email, disbursement, or contact details are verified by a known-good channel (e.g., phone call to the number on file) before acting.
- The Firm's public Privacy Policy (tideventurecpa.com/privacy) accurately describes data practices and is kept consistent with this plan.
- Client relationships are governed by a signed engagement letter including confidentiality, electronic-communication, and record-retention terms.

### 5.2 Technical
- **Encryption in transit:** TLS on all web properties; HSTS enabled.
- **Encryption at rest:** client documents and questionnaire responses encrypted with AES-256-GCM using per-client derived keys; OAuth tokens (Gmail, QuickBooks) encrypted with AES-256-GCM.
- **Authentication:** admin panel gated by Cloudflare Access (email one-time PIN = MFA) in addition to application login; client passwords minimum 10 characters, hashed with PBKDF2 (100k iterations, per-user salt).
- **Session management:** JSON Web Tokens with 24-hour expiry; session status re-verified server-side on each session check.
- **Rate limiting:** login attempts (5 per 15 minutes per account) and password-reset requests (3 per hour per account).
- **Audit logging:** append-only log of security-relevant events (document upload/download/delete, signatures, password resets, emails sent, backups).
- **Security headers:** HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy on all responses.
- **Backups:** nightly incremental copy of all portal data to a separate bucket; restoration possible for any object.
- **Software updates:** [FILL IN — e.g., "Operating system and browser auto-update enabled on all firm devices"].

### 5.3 Physical
- Firm devices require a password/biometric lock and full-disk encryption ([CONFIRM: FileVault enabled on Mac]).
- Devices are not left unattended and unlocked in public places.
- Paper documents containing client data, while in the Firm's custody, are stored in [FILL IN — locked cabinet/office]; originals are returned to clients at engagement end.
- Disposal: paper is cross-cut shredded; electronic media is securely erased before disposal or recycling.

## 6. Access Controls

- Client portal accounts can access only that client's own records; cross-client access is enforced server-side.
- Firm-issued documents cannot be deleted by clients.
- Administrative access requires both Cloudflare Access authentication and an admin application login (@tideventurecpa.com identity).
- Account provisioning: client accounts are created only by the principal through prospect conversion; setup links expire in 24 hours.
- When any staff are hired in the future: unique accounts per person, least-privilege access, immediate revocation on separation, and security training at onboarding (see §9).

## 7. Service Providers

| Provider | Service | Data involved | Oversight |
|---|---|---|---|
| Cloudflare | Hosting, storage (R2), admin access gateway | All portal data (encrypted) | SOC 2 / ISO 27001 certified; review status annually |
| Google (Workspace/Gmail) | Firm email, regulatory feed ingestion, transactional email | Client correspondence | OAuth scopes limited to read + send; tokens encrypted; review annually |
| Intuit (QuickBooks Online) | Client accounting/billing | Client financial data | Client-authorized OAuth; review annually |
| PandaDoc | E-signature (where used) | Documents sent for signature | Review annually |
| Intuit (tax prep — ProConnect/Lacerte/ProSeries) | Tax preparation & e-filing | Full tax return information | Same vendor family as QuickBooks Online; confirm which product and review its security documentation annually |

The Firm selects providers capable of maintaining appropriate safeguards and reviews this list, including each provider's security posture and the necessity of each integration, at least annually.

## 8. Incident Response Plan

Upon discovering or suspecting unauthorized access to customer information, the Qualified Individual will:

1. **Contain** — revoke affected credentials/tokens, rotate secrets (Cloudflare, JWT, encryption keys as appropriate), and disable compromised accounts.
2. **Assess** — use audit logs and provider logs to determine what data was accessed, whose, and when.
3. **Notify — legal/regulatory:**
   - **IRS Stakeholder Liaison** for the Firm's state — promptly (data theft affecting taxpayer information).
   - **State tax agencies** in affected states (e.g., via the Federation of Tax Administrators' StateAlert process).
   - **FTC** — within 30 days if unencrypted information of **500+ consumers** is involved (Safeguards Rule §314.5).
   - **State breach-notification laws** for affected clients' states of residence.
4. **Notify — business:** professional liability (E&O) carrier: [FILL IN carrier and policy number]; consider engaging a breach-response/forensics firm.
5. **Notify — clients:** inform affected clients promptly and honestly, with concrete guidance (e.g., IRS Form 14039 Identity Theft Affidavit, credit monitoring).
6. **Remediate and document** — fix the root cause, record a written post-incident summary, and update this plan.

Key contacts: IRS Stakeholder Liaison ([FILL IN local number from irs.gov]), E&O carrier ([FILL IN]), state board of accountancy ([FILL IN]).

## 9. Training

The Firm is currently a sole practice; the principal completes periodic security awareness refreshers (e.g., IRS Pub 4557 review at each PTIN renewal, IRS "Security Six" checklist). Any future staff or contractors with data access will receive security training at onboarding and annually, and will acknowledge this WISP in writing.

## 10. Monitoring, Testing, and Review

- Audit log reviewed periodically for anomalous activity.
- Backup status verified via the admin panel; a test restoration performed at least annually.
- This plan is reviewed and re-approved at least **annually**, and immediately after any security incident or material change to systems or providers.
- The Firm affirms maintenance of this WISP as part of annual PTIN renewal.

## 11. Revision History

| Date | Change | By |
|---|---|---|
| Aug 5, 2026 | Initial plan adopted | Isaac Frisch, CPA |

---

**Adopted by:**

Isaac Frisch, CPA — Principal, TideVenture CPA

Signature: _______________________  Date: _____________
