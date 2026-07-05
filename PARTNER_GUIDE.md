# Tax Rebate Calculation Tool — Partner Guide

This is the guide for any country with a factory tax-rebate arrangement with us. It explains how a deal gets set up, how it gets logged, and how you check your own numbers.

**Page:** [tools.we-ie.com/#tax-deals](https://tools.we-ie.com/#tax-deals) (also linked from the **Partner tools** tab on the site).

## What this actually does

Every day, a script scans the relevant factories, works out how much tax they generated, and works out the rebate owed under your deal's terms. That gets logged automatically — nobody has to type numbers in by hand, and nobody has to trust anyone's word for it. You can go back and check any day's figures at any time.

It is **not** a live calculator you can query on demand — it's a daily settlement log. Today's figure appears once the daily scan has run (usually mid-afternoon UTC); it doesn't update in real time.

## One-time setup: getting your country's password

We give you **one password for your country**. It does two things:

- Proves you actually represent your country when proposing a deal (rather than letting anyone propose terms in your name).
- Unlocks viewing **every** deal your country is a party to on the dashboard — you don't need a different password per deal.

Keep it private; don't post it publicly. If you don't have one yet, ask us for one.

## Proposing a deal

1. Go to the [#tax-deals](https://tools.we-ie.com/#tax-deals) page.
2. Click **"+ Propose a new deal"**.
3. Fill in:
   - **Deal name** — anything descriptive, e.g. "Ireland – Yemen Factory Tax Rebate".
   - **Home country** — the country whose citizens own the factories (type the name, pick it from the dropdown).
   - **Host country** — your country (type the name, pick it from the dropdown).
   - **Your country's password** — the password we gave you (see above).
   - **Home-citizen rebate %** and **Non-home-citizen rebate %** — the two rebate rates your deal agrees to. These can be different (e.g. a higher rebate for the home country's own citizens working in your factories, a lower one for everyone else).
   - **Start date** — the first day the deal applies from. Anything before this date is never logged for the deal.
4. Click **Submit for review**.

## What happens next

Your proposal doesn't go live immediately. It's held for manual review — we check the numbers make sense before it starts logging real figures. Once approved, logging starts automatically from the next daily run, and you don't need to do anything further.

If a submission fails, you'll see an error explaining why (wrong password, dates in the wrong format, rebate percentages out of range, etc.) — just fix it and resubmit.

## Viewing your data

1. Go to the [#tax-deals](https://tools.we-ie.com/#tax-deals) page.
2. Select the home country of the deal you want to check.
3. Select the deal from the second dropdown.
4. Enter your country's password.

The same password unlocks any deal your country is the host of — you don't need to remember a different one per deal. You'll only ever see your own deals' numbers — nothing about any other country's arrangement is shown or linked from this page.

### What the dashboard shows

- **Today's rebate due** — the manual rebate owed based on today's logged scan.
- **This week's rebate due** — accrued since Monday.
- **Previous week's rebate due** — last week's final total, once a new week has started.
- **Gross tax generated** — the total wage tax your factories generated this week, before any rebate.
- **Workers** — how many workers were counted in today's scan.
- **Home-country vs. non-home-country citizens** — the rebate is split by worker citizenship, shown side by side with each rate.
- **Paper transfer tax** — settling a rebate through the game's "Send money to country" mechanic costs paper (50% if allied, 100% if not). This section shows the current paper price, what it'll cost to pay this week's rebate, how much paper is needed, and the net amount after that cost.
- **Settlement report** — a ready-to-send summary with a **Copy** button, formatted like:
  ```
  Yemen → Ireland Tax Rebate Settlement
  Period: 29 Jun – 5 Jul

  Gross tax generated: ₿X
  Manual rebate owed to Ireland: ₿X
  Automatic citizenship tax already handled by game: ₿X
  Yemen retained: ₿X

  Please transfer: ₿X
  ```

## A few things worth knowing

- **The game's automatic 30% remittance is separate and already excluded.** The rebate figure here is only the *additional* manual amount your deal adds on top of what the game already auto-remits to each worker's citizenship country.
- **Passwords here are a convenience gate, not encryption.** This site is fully public/static — the underlying data file for any deal is technically fetchable by URL by anyone who knows it. The password just controls what the page itself shows and links to; it doesn't add real cryptographic protection. Don't reuse a password you use anywhere sensitive.
- **If a day is missing figures**, it usually means the daily scan didn't see data (an API hiccup) — it retries automatically later the same day rather than logging a false zero.
- **Rebate rates can change over time.** If your deal's terms are renegotiated, let us know and we'll update it — historical days keep the rate that was in force when they were logged, so past settlements are never silently recalculated under new terms.

## Questions or issues

Reach out to us directly (not through this page) if your password isn't working, a deal looks wrong, or you want to renegotiate terms.
