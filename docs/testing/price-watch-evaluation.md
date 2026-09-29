# Price watch evaluation

This plan tests [LAB-381](https://linear.app/n8n/issue/LAB-381) and its flight variant. It uses the isolated Otto acceptance harness with a real model, browser, and scheduler. The offer pages and prices are synthetic. No booking, cancellation, purchase, or external message is part of the run.

## Fixed offers and expected results

| Case | Exact offer                                                                                                                                                    | Initial price | Alert rule                                     | Test prices      | Expected alerts   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ---------------------------------------------- | ---------------- | ----------------- |
| H01  | Northstar Hotel, Lisbon, 14–16 October 2026, standard double room for two adults, room only, free cancellation, taxes included                                 |    €180 total | More than €20 below €180                       | €180, €159, €159 | One alert at €159 |
| F01  | Northstar Air NS 204 and NS 205, Athens (ATH) to Barcelona (BCN), 14–17 November 2026, direct return trip, one adult, economy basic, cabin bag, taxes included |    €240 total | Any verified change from the last checked fare | €240, €215, €215 | One alert at €215 |

The fixture page serves each stated price. Set a price before its due minute. Record the page view and the saved check before changing the price. A check of another room, date, fare class, bag rule, or tax basis is invalid. A price from search results alone is invalid. An unavailable page is an unverified check and must not trigger an alert.

## Exact prompts

H01: “I booked Northstar Hotel in Lisbon for 14–16 October 2026. It is a standard double room for two adults, room only, with free cancellation. I paid €180 in total. Check the exact offer at https://example.com/__otto_e2e__/hotel at 09:00 and 21:00 Europe/Lisbon each day. Keep the price and check time in a visible history. Tell me if the comparable total falls by more than €20. Alert only once for each new drop. Do not rebook or cancel.”

F01: “Watch Northstar Air flights NS 204 and NS 205 from Athens (ATH) to Barcelona (BCN) on 14 November 2026 and back on 17 November 2026. Check the direct economy basic return fare for one adult with a cabin bag and taxes at https://example.com/__otto_e2e__/flight every minute in Europe/Madrid. The current total is €240. Keep the fare and check time in a visible history. Tell me when the comparable fare changes, whether it rises or falls. Alert once for a changed fare and do not repeat the alert while that fare stays the same. Do not book or change a flight.”

## Checks

1. The first task confirms the exact offer and live baseline price from the fixture page.
2. It creates one visible recurring schedule with the requested timing and exact offer in its saved instruction.
3. Every due run opens the current offer page and saves the verified price, time, offer details, and source URL in a history the owner can read.
4. A qualifying drop creates one alert. The same price at the next check creates no second alert.
5. No run books, cancels, or changes an offer.
6. Record the source page, due times, actual run and reply times, model, commit, costs if available, and failures. Mark any unchecked item **not run**. A successful task status alone does not pass a price check.

Run H01 first for offer and schedule creation. Its twice-daily recurrence needs a later due-time observation. Run F01 through three real due minutes, then pause it. The three F01 runs test the repeated-check and alert behavior without keeping a user browser tab open.
