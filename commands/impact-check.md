---
description: Cross-module impact analysis for a Magento 2 / Mage-OS code change. Identifies what depends on the changed code — callers, DI preferences, plugin chains, observers, crons, and data dependencies — so you can spot blast radius BEFORE deploying. Combines grep, magento2-lsp MCP, config XML reading, and structured LLM reasoning.
argument-hint: <file-path-or-glob>  (or omit to use current branch's diff vs live)
---

You are running an impact-check on Magento 2 / Mage-OS code changes. Your job is to detect what else in the codebase could be affected — including non-obvious data dependencies (a cron writing to a table other modules read) — and report it BEFORE the user deploys.

This is the high-stakes feature that historically saved 1000s of customer tax configurations from being clobbered by a cron-on-deploy. Be thorough, cite evidence, and flag your confidence level.

---

## Step 1 — establish the change set

If `$ARGUMENTS` is a file/glob, that's the scope. Otherwise, run:
```bash
git diff --name-only $(git merge-base HEAD live 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo HEAD~1)
```
to get changed files vs the LIVE-equivalent branch. List the files for the user. Confirm scope with ONE line:

```
Impact-check scope: <N> file(s). Proceed? y/n
```

If they want to narrow, accept a refined list.

## Step 2 — extract changed symbols

For EACH changed PHP file, identify what specifically changed:
- `git diff <merge-base>..HEAD -- <file>` to see the actual hunks
- Extract the method signatures touched by the diff (look for context lines containing `public function`, `protected function`, `private function`)
- Extract changed XML node identifiers if it's an `etc/*.xml` file (event name, cron job name, DI preference)

Build a working list:

```
Changed symbols:
- Vendor_Foo\Model\TaxCertificate::save() [method body changed]
- Vendor_Foo\etc\crontab.xml: <job name="foo_tax_certificate_refresh"> [schedule changed]
- ...
```

## Step 3 — for each changed PHP method, find the impact surface

For EACH method on the working list, gather the following evidence. Use bash, grep, Read, AND the `magento2-lsp` MCP server (it's the source of truth for Magento config wiring):

### 3a. Direct callers
```bash
grep -rn "->methodName\b\|::methodName\b" app/code/ vendor/ --include="*.php" | head -50
```

Filter the grep output to actual call sites (skip method definitions, comments). If callers are numerous, prioritize:
- Calls from OTHER modules (not the same vendor as the changed code)
- Calls inside cron jobs, observers, plugins, controllers

### 3b. DI preferences pointing AT the class
Ask `magento2-lsp` MCP: does any other module have a `<preference for="<changed-class>" type="..."/>`? If yes, those classes' callers also matter (transitively affected).

### 3c. Plugins on the changed method
Search for `etc/di.xml` entries with `<type name="<changed-class>"><plugin name="..." type="..."/></type>` — these are interception chains. Plugins around/before/after the changed method's behavior may break if the method's signature, return type, or side effects shift.

### 3d. Events the method dispatches
Look for `$this->_eventManager->dispatch('event_name', [...])` or `$eventManager->dispatch(...)` calls INSIDE the method body. For each event name found, search:
```bash
grep -rn 'event name="<event_name>"' app/code/ vendor/ --include="events.xml"
```
to find observers. Each observer is an impacted module.

### 3e. Tables/models the method writes to (THE TAX-CERT CASE)
This is the data-flow piece. Read the method body and look for:
- `$this->getConnection()->insert/update/delete(...)` — extract table name
- `$resourceModel->save(...)`, `$repository->save(...)` — trace back to the model class, then to its `_init('<table_name>', '<pk>')` call to identify the table
- `Magento\Framework\Model\AbstractModel::save()` invocations

For each table identified, search the codebase for OTHER read/write sites:
```bash
grep -rn '_init.*<table_name>\|getConnection.*<table_name>' app/code/ --include="*.php" | head -30
grep -rn '<table_name>' app/code/ --include="*.xml" | head -20
```

Then check **etc/crontab.xml** files for any cron job whose `instance` class touches the same table — this is exactly the case that saved tax certificates.

## Step 4 — for changed XML config, find impact

If the change is in `etc/crontab.xml`, `etc/events.xml`, `etc/di.xml`, or `etc/queue_consumer.xml`:

- **crontab.xml change**: did the schedule change? Did the job instance class change? Did the job get added/removed? List downstream consumers of the data the job mutates (Step 3e logic).
- **events.xml change**: which event observers were added/removed/redirected? Re-resolve via `magento2-lsp` to identify the canonical observer chain.
- **di.xml change**: preference change → callers of the old type are now using the new type (impact); plugin add/remove → that method's chain shifted.

## Step 5 — write the impact report

Output a structured markdown report:

```
# Impact analysis — <N> changed file(s)

## Changed symbols
- Vendor_Foo\Model\TaxCertificate::save() — method body changed
- Vendor_Foo/etc/crontab.xml — job foo_tax_certificate_refresh schedule changed

## Direct impact (high confidence)
- **Vendor_Bar\Model\CustomerSync** calls TaxCertificate::save() at line 145 — affected if return type or side effects changed
- **ItTools\TaxImport\Observer\PostImport** observes `tax_certificate_saved` event (dispatched by changed method) — receives stale payload if event args changed

## Indirect impact (medium confidence)
- **Hiddentechies\Compliance\Cron\CertExporter** writes to the same table (`customer_tax_certificate`) every 6 hours — concurrent-write hazard if the new cron schedule overlaps
- Plugin chain: **ProxiBlue\TaxAudit\Plugin\TaxCertificateLogger** intercepts ::save() with around-plugin — must validate against new signature

## Data flow (HIGH RISK if confirmed)
- The cron schedule change in foo_tax_certificate_refresh from `0 */6 * * *` to `0 0 * * *` means it now overlaps with **CertExporter** cron at midnight UTC. **Customer tax certificate data could be clobbered.** Recommend:
  - Stagger the schedules (offset by 30+ minutes), OR
  - Add row-level locking on the import path, OR
  - Hold the deploy until both crons are reviewed together

## What I did NOT check (limitations)
- LLM-driven analysis: I traced what grep + magento2-lsp could surface. Indirect call chains beyond 2 hops may be missed.
- Vendor modules: only checked vendor/ if explicitly referenced; full vendor cross-reference would require deeper indexing.
- Composer dependencies: did not check `composer.json` for downstream package consumers.

## Recommended next steps
1. <specific action>
2. <specific action>
```

## Step 6 — surface to Graphiti (optional)

If the impact analysis catches a non-trivial fact worth long-term memory (e.g., "Tax certificate cron and CertExporter cron compete for the same table"), suggest the user save it to Graphiti via:

```
add_memory(group_id="<project-id>", name="Tax-cert cron concurrency hazard", episode_body="...", source_description="pb-codegraph impact-check <date>")
```

That way the next time someone considers a similar change, the SessionStart recall would surface the prior warning.

## Hard rules

1. **Cite evidence** — every claim ("affected", "depends on") must have a file path + line number or XML node reference.
2. **Distinguish confidence levels** — "direct call" is high; "writes the same table" is medium (concurrent write may not be a problem if proper locking exists); "transitively via 3 hops of DI" is low.
3. **Flag what you did not check** — be explicit about the limits of LLM-driven analysis vs a proper deterministic graph (the v0.2+ roadmap). Don't claim deterministic accuracy you cannot deliver.
4. **Never claim "safe to deploy"** unless every changed symbol's impact surface is empty AND the user has confirmed the data-flow checks pass.
