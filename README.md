# War Era tools

An Irish player's toolkit for [War Era](https://app.warera.io/). Live at [tools.we-ie.com](https://tools.we-ie.com).

## Tools

### 🇮🇪 Irish Military Units

Every MU owned by an Irish citizen, in Ireland, with a majority Irish roster. Filter by whether they have open slots, see who's already inside, and click through to the game.

MUs need to pass three checks to appear:
- Owner is currently an Irish citizen
- MU's country (if exposed) is Ireland
- At least half of the members are Irish

### 🏭 Company Migration Advisor

Enter your War Era username to see whether each of your companies is in its best country, and how much extra output or take-home a move would gain you.

Bonuses come from strategic resources, regional deposits, and two industrialism modifiers gated by the country's lean. Income tax only affects the ranking on companies you work in yourself.

## URLs

Every view is hash-routed and deep-linkable.

- `#home` → landing page
- `#mu` → Irish Military Units
- `#mu?filter=open` → MUs with free slots
- `#mu?filter=full` → full MUs
- `#advisor` → Migration Advisor, empty
- `#advisor?u=toie` → Migration Advisor pre-loaded for a user

The advisor updates the URL when you analyse, so the address bar is always shareable.

## Credit
&bypass=1
By toie. Live data via the [War Era Gateway](https://gateway.warerastats.io/). Industrialism data from [warerastats.io](https://warerastats.io/).