# Adverse Media Search+ coverage map — 3 November 2026

This is a supplier-neutral description of the Search+ capability in branch `codex/adverse-media-no-adverse-bucket`. It describes configured search scope and per-run limits, not a guarantee that every article in a country or outlet is indexed. Production has not been updated by this branch.

## Search channels and depth

| Channel | Geographic scope | Search depth per run | Evidence window | Recorded in the response |
| --- | --- | --- | --- | --- |
| Current news | Worldwide indexed news, with requested-language queries | Up to 50 returned items per scheduled query | No fixed completeness guarantee; optional customer date filter | `current_news` entry in `coverage.sources`, `languages_searched`, article URLs and dates |
| Open web | Worldwide indexed public pages, including regulator-domain queries where configured | Up to 20 returned items per scheduled query | Indexed pages, with optional customer date filter | `open_web` entry in `coverage.sources`, `regional_packs`, article/page URLs and dates |
| Publisher-targeted Search+ | Site-restricted queries selected from the 39-market catalog below; requested countries are prioritized | At most six batches, ten domains per batch, and 20 returned items per query | Indexed articles, with optional customer date filter | `publishers_screened`, `publishers_not_completed`, `matched_publishers`, batch counts |
| Local historical index | Locally stored, entity-indexed public news records | Name, alias, and resolved-association lookups, bounded by the index's stored records | Actual `coverage_start` and `coverage_end` watermark; daily ingestion | `archive_origin: local_index`, `archive_snapshot`, `archive_window` |
| Historical fallback | Hosted public-news archive when the local watermark does not cover the request | Up to 50 returned items | Up to one year; older requested history is not assured by this channel | `archive_origin: hosted_fallback`, `archive_window` |
| Applicable official records | Targeted official-domain web searches; a dedicated warning-list check for the Russia pack | Included within the same search budget, plus the applicable free record check | Source-dependent | `regional_packs`, `coverage.sources.official_records` |

The paid search budget is **12 queries total**, including any association discovery and follow-up. Search+ reserves a first pass for each requested language and at least one publisher batch. A run retains at most **50** deduplicated candidates (default **25**) before classification. A no-hit response means no qualifying result was returned within this defined scope; it is not proof that no adverse article exists.

The worldwide indexed searches use worldwide search scope even when `countries` is supplied. Country inputs activate relevant terms and official-domain packs and prioritize local publishers; they are not a hard country filter. The 1,527-domain catalog is an approved selection pool. **1,391 domains** have categories eligible for publisher-targeted queries. The exact domains actually searched are listed on each successful response and PDF, never inferred from the catalog count.

## Configured languages

Up to five per request, from these 17: Arabic (`ar`), German (`de`), English (`en`), Spanish (`es`), Persian (`fa`), French (`fr`), Hindi (`hi`), Indonesian (`id`), Italian (`it`), Dutch (`nl`), Polish (`pl`), Portuguese (`pt`), Russian (`ru`), Turkish (`tr`), Ukrainian (`uk`), Urdu (`ur`), and Chinese (`zh`). The default is English and Arabic. Indonesian terms are queried, but the indexed search has no Indonesian language filter, so that query uses a broader language preference. Automatic name transliteration is not performed; supply alternate-script aliases when needed.

Focused regional query packs cover the Gulf (`AE`, `SA`, `QA`, `KW`, `BH`, `OM`), Indonesia (`ID`), China (`CN`), Russia (`RU`), India (`IN`), the United States (`US`), and Australia/New Zealand (`AU`, `NZ`). They activate from matching countries or relevant languages. Other countries can still be supplied and searched through the worldwide index; a focused pack is a query and source enhancement, not the boundary of geographic search.

## Publisher selection pool by market

`Catalog` includes all approved domains, including categories not selected for targeted Search+ queries. `Searchable` is the eligible selection pool. The nine three-domain markets at the end are the regional additions in this branch. Domain-level source records are in [the existing catalog](../top_50_media_publishers_30_largest_economies_2026.json) and [the supplemental catalog](../lib/search-plus-supplemental-publishers.json).

| Market | Code | Catalog | Searchable |
| --- | --- | ---: | ---: |
| United States | US | 50 | 44 |
| China | CN | 50 | 46 |
| Germany | DE | 50 | 46 |
| Japan | JP | 50 | 49 |
| United Kingdom | GB | 50 | 44 |
| India | IN | 51 | 51 |
| France | FR | 50 | 46 |
| Russia | RU | 50 | 46 |
| Italy | IT | 50 | 41 |
| Brazil | BR | 50 | 45 |
| Canada | CA | 50 | 43 |
| South Korea | KR | 50 | 44 |
| Mexico | MX | 50 | 49 |
| Australia | AU | 50 | 41 |
| Spain | ES | 50 | 44 |
| Türkiye | TR | 50 | 47 |
| Indonesia | ID | 50 | 45 |
| Netherlands | NL | 50 | 39 |
| Saudi Arabia | SA | 50 | 48 |
| Switzerland | CH | 50 | 50 |
| Poland | PL | 50 | 38 |
| Taiwan | TW | 50 | 50 |
| Belgium | BE | 50 | 37 |
| Argentina | AR | 50 | 49 |
| Israel | IL | 50 | 48 |
| Sweden | SE | 50 | 49 |
| Ireland | IE | 50 | 47 |
| Singapore | SG | 50 | 49 |
| United Arab Emirates | AE | 50 | 42 |
| Norway | NO | 50 | 48 |
| Qatar | QA | 3 | 3 |
| Kuwait | KW | 3 | 3 |
| Bahrain | BH | 3 | 3 |
| Oman | OM | 3 | 3 |
| Egypt | EG | 3 | 3 |
| Pakistan | PK | 3 | 3 |
| South Africa | ZA | 3 | 3 |
| Nigeria | NG | 3 | 3 |
| Kenya | KE | 3 | 3 |

The per-market catalog counts can sum above 1,527 because a domain may appear in more than one market. Catalog membership does not prove the outlet is indexed or that its articles were found. Search+ records successful site-restricted queries as `publishers_screened`; an error is returned if required search coverage fails.

## Local index status at review time

The production local archive watermark inspected on 3 November 2026 covered **22 October 2026 21:15 UTC to 3 November 2026 01:30 UTC**. Its eight most recent scheduled ingestions had succeeded. This is a time-stamped operational observation, not a permanent promise of archive history. The API reports the actual watermark and age on each run. Older requested ranges rely on the hosted historical fallback until the local index is backfilled further.
