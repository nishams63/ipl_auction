# Player Catalogue Import Report: Sets 02 and 03

**Status:** REVIEW ONLY. **Nothing has been imported.** `server/data/players.json` is unchanged (290 players). No room, squad or auction history has been touched.  
**Date:** 16 Nov 2026  
**Inputs:** `ipl_auction_set_02 (1).html` (79 records), `ipl_auction_set_03.html` (100 records), compared against the 290-player catalogue in `server/data/players.json`.  
**Reproduce:** `node scripts/catalogue/compare-candidates.mjs out.json server/data/sources/ipl_auction_set_02.html server/data/sources/ipl_auction_set_03.html` (read-only).  
**Files:** machine evidence in `docs/catalogue/candidates_set02_03.evidence.json`; proposed per-record decisions in `docs/catalogue/review_decisions_set02_03.json`.

> Both files say earlier sets were excluded. I did not rely on that: every record was compared against the app's actual catalogue and against every other record.

## 1. Summary

| Measure | Count |
|---|---|
| Records in Set 02 / Set 03 | 79 / 100 (179 total; matches each file's footer) |
| Current catalogue | 290 |
| Exact-name duplicates of existing players | 0 |
| Normalised-name duplicates (case, spaces, punctuation, accents) | 0 |
| **Probable duplicates, high confidence** (spelling or order variants) | **6** |
| **Possible duplicates, manual review needed** (medium confidence) | **5** |
| Duplicates *inside* the uploaded files | **1** (Set 03 lists Gulbadin Naib twice, under two spellings; its "100 unique" claim is really 99) |
| Incomplete identities (initials only), held | 4 |
| Domestic prospects with no confirmed IPL match (Set 03 marks these) | 12, needs your policy decision |
| Similar names confirmed as **different** players (keep separate) | 15 |
| Structurally invalid records (missing name, country or category) | 0 |
| **Clear new players ready to add** | **151** |

### Final unique count

| Scenario | New players | Catalogue size |
|---|---|---|
| Clear new players only (recommended first import) | 151 | **441** |
| + the 12 domestic prospects | 163 | 453 |
| + the 4 held names, once full names are confirmed | 167 | 457 |
| + the 5 medium-confidence matches, if review finds them to be different players | 172 | 462 (maximum) |

After the recommended first import, categories would be: BAT 57→92, BOWL 60→122, AR 58→88, SP 58→69, WK 57→70. Overseas players would rise from 97 to 166.

## 2. Method

1. **Extraction:** each player card's name, country, category code and season/note was read from the HTML. Category mapping: FAST→BOWL, SPIN→SP, BAT/AR/WK unchanged, matching `buildPlayers.js`. HTML entities were decoded (for example `William O'Rourke`).
2. **Exact match** on the raw name, then **normalised match**: lower case, accents removed, apostrophes removed, `.` and `-` treated as spaces, whitespace collapsed.
3. **Alias evidence:** reordered tokens, merged tokens (`Vijay Kumar` vs `Vijaykumar`), a shared distinctive name token (very common names such as Singh, Sharma or Kumar are not counted as evidence), an initial matching a first name, character similarity of 0.85 or more, and same surname with a similar first name.
4. **Human review** of every flagged pair against country, category and role. A pair is only called a duplicate when the name evidence *and* the attributes agree. Similar names alone never merge players.

## 3. Probable duplicates, high confidence (proposed: skip the candidate, keep the existing ID)

| Candidate | Source | Existing record | Why it is the same player |
|---|---|---|---|
| Vaibhav Suryavanshi | Set 03 | `PL_167` Vaibhav Sooryavanshi | Transliteration variant Surya-/Soorya-; same country (India) and role (BAT) |
| Vyshak Vijay Kumar | Set 03 | `PL_253` Vijaykumar Vyshak | Same tokens in different order ("Vijaykumar Vyshak"); same country and role (fast bowler) |
| Philip Salt | Set 03 | `PL_040` Phil Salt | "Phil" is the short form of "Philip"; same country (England) and role (WK) |
| Abishek Porel | Set 03 | `PL_113` Abhishek Porel | Transliteration variant Abishek/Abhishek; same country (India) and role (WK) |
| Auqib Nabi Dar | Set 03 | `PL_255` Auqib Nabi | Existing record omits the surname "Dar"; same country and role (fast bowler) |
| Digvesh Rathi | Set 03 | `PL_187` Digvesh Singh Rathi | Existing record includes the middle name "Singh"; same country and role (spinner) |

## 4. Possible duplicates, manual review required (medium confidence)

Proposed: **do not import until you confirm.** If you confirm they are the same, the candidate is skipped and the existing ID is kept. If they are different, the candidate is added under a new ID.

| Candidate | Source | Existing record | Evidence and doubt |
|---|---|---|---|
| Karan Sharma | Set 02 | `PL_145` Karn Sharma | "Karan"/"Karn" spelling variant; both Indian spinners. "Sharma" is very common, so it could be a different player |
| Aman Hakim Khan | Set 02 | `PL_183` Aman Khan | Existing "Aman Khan" (AR, India, medium pace and power batting) matches this all-rounder profile; the middle name is missing from the existing record |
| Rasikh Salam | Set 03 | `PL_252` Rasikh Dar | Existing "Rasikh Dar" shares the distinctive first name; same country (India) and role (fast bowler). The two surnames are plausibly parts of one full name, but the files give no full names |
| T Dahiya | Set 03 | `PL_233` Tejasvi Dahiya | Initial "T" matches "Tejasvi"; same surname, country and role (WK); the initial alone cannot prove identity |
| LG Pretorius | Set 03 | `PL_194` Lhuan-dre Pretorius | Same surname, country (South Africa) and role (WK); the "L" matches "Lhuan-dre" but the "G" cannot be checked |

## 5. Duplicate inside the uploaded files

- **Gulbudeen Naib** (Set 03, AR-13) and **Gulbadin Naib** (Set 03, AR-11): Two spellings of the same Afghan all-rounder; both listed in Set 03 (AR-11 and AR-13) with identical country and season. Proposed: import once, as *Gulbadin Naib*, and skip *Gulbudeen Naib*.

## 6. Held: incomplete identity

| Candidate | Category | Note in file | Why held |
|---|---|---|---|
| BR Sharath | WK | IPL appearance · 2024 | Only initials and a given name; full name needed for a stable identity |
| SU Parakh | BAT | IPL appearance · 2026 | Only initials and surname given; full name needed for a stable identity |
| DV Malewar | BAT | IPL appearance · 2026 | Only initials and surname given; full name needed for a stable identity |
| RS Ghosh | BOWL | IPL appearance · 2026 | Only initials and surname given; very common surname; full name needed |

`KM Asif` and `KS Bharat` also use initials, but these are the standard published forms of those players' names, so they are not held.

## 7. Domestic prospects: policy decision needed

Set 03 itself marks these as *"Domestic prospect · no IPL match confirmed"*. Should players with no IPL appearance be in the auction?

| Candidate | Category | Note in file |
|---|---|---|
| Yuvraj Chaudhary | AR | Domestic prospect · 2025 squad · no IPL match confirmed |
| Pyla Avinash | BAT | Domestic prospect · 2025 squad · no IPL match confirmed |
| Andre Siddarth | BAT | Domestic prospect · 2025 squad · no IPL match confirmed |
| Tejas Baroka | SP | Domestic prospect · 2022 squad · no IPL match confirmed |
| Aneeshwar Gautam | AR | Domestic prospect · 2022 squad · no IPL match confirmed |
| Kunal Rathore | WK | Domestic prospect · 2025 squad · no IPL match confirmed |
| Pratham Singh | BAT | Domestic prospect · 2022 squad · no IPL match confirmed |
| Shubham Garhwal | BAT | Domestic prospect · 2022 squad · no IPL match confirmed |
| Anunay Singh | BOWL | Domestic prospect · 2022 squad · no IPL match confirmed |
| Ansh Patel | SP | Domestic prospect · 2022 squad · no IPL match confirmed |
| Ramesh Kumar | AR | Domestic prospect · 2022 squad · no IPL match confirmed |
| Krishnan Shrijith | WK | Domestic prospect · 2025 squad · no IPL match confirmed |

## 8. Similar names that are different players (keep separate)

| Candidate | Similar to | Why they are different |
|---|---|---|
| Kuldip Yadav | PL_025 Kuldeep Yadav | different role: fast bowler vs left-arm wrist spinner |
| Shubham Garhwal | PL_229 Shubham Agarwal | different surname; batter vs leg-spinner |
| Mandeep Singh | PL_097 Ramandeep Singh | different first name; batter vs all-rounder |
| Mohit Sharma | PL_003 Rohit Sharma | different first name; fast bowler vs batter |
| Fabian Allen | PL_114 Finn Allen | West Indies all-rounder vs New Zealand wicketkeeper |
| Dwaine Pretorius | PL_194 Lhuan-dre Pretorius | all-rounder vs wicketkeeper |
| Duan Jansen | Marco Jansen (Set 02) | twin brothers; both candidates are distinct players |
| Kusal Mendis | PL_088 Kusal Perera / PL_177 Kamindu Mendis | three distinct Sri Lankan players |
| Mukesh Choudhary | PL_158 Mukul Choudhary | fast bowler vs wicketkeeper |
| Abhishek Sharma | PL_113 Abhishek Porel | different surnames |
| Kuldeep Sen | PL_025 Kuldeep Yadav | different surnames |
| Harpreet Singh Bhatia | PL_269 Harpreet Brar | batter vs spinner; different surnames |
| KS Bharat | Krish Bhagat (Set 03) | wicketkeeper vs fast bowler |
| David Willey | David Wiese (Set 03) | England vs Namibia |
| Ravichandran Ashwin | PL_111 Murugan Ashwin | different players; shared name only |

The lobby and marquee should show a role or country next to these names so bidders don't confuse them, especially *Kuldip* and *Kuldeep* Yadav.

## 9. Missing fields and data quality (applies to all 179 records)

| Field the app uses | In the files? | Proposed handling (needs your approval) |
|---|---|---|
| `name`, `country` | Yes | Use as given |
| `category` | Yes (category code) | Map FAST→BOWL, SPIN→SP |
| `isOverseas` | Derivable | `country !== 'India'` (same rule as `buildPlayers.js`) |
| `role` (e.g. "Opening Batter") | **No** | Use a generic label from the category ("Batter", "Fast Bowler", "Spin Bowler", "All-Rounder", "Wicketkeeper"), marked as category-derived. No invented specialisms. |
| `basePrice` | **No** | **Your decision.** The files give no prices, and I won't invent per-player values. One option is a flat price by group, for example uncapped domestic ₹0.30 Cr and others ₹0.50 Cr. |
| `rating` | **No** | Leave empty. **Important:** the current evaluation treats a missing rating as **80** (`p.rating \|\| 80`), which would silently grade 151+ players. This must be handled in the Stage 7 evaluation rework before or alongside the import. |
| `stats` | **No** | Leave empty; the UI shows "Not available". No invented statistics. |
| `imageUrl` | Only Bing image-search thumbnails | Not used (unreliable and of unknown licence). Show an initials placeholder until verified images exist. |
| Season or appearance notes | Yes | Kept as *source-provided* metadata. I have **not** independently verified IPL appearances. |

**Possibly retired players (unverified):** Set 03 says players who retired after 2022 may appear. From my general knowledge, and not checked for this report, these are widely reported as retired from the IPL: Ambati Rayudu, Robin Uthappa, Kieron Pollard, Dwayne Bravo, Dinesh Karthik, Shikhar Dhawan, Wriddhiman Saha, Ravichandran Ashwin, Piyush Chawla, Kedar Jadhav, Varun Aaron, Amit Mishra. **Please decide** whether retired players belong in the auction pool; I can verify individual names if you want.

## 10. Proposed import procedure (not run; awaiting approval)

1. You approve or amend `docs/catalogue/review_decisions_set02_03.json` (sections 4–9 and the base-price policy).
2. A new script, `scripts/catalogue/import-candidates.mjs`, reads the approved decisions and **appends** players with new stable IDs starting at `PL_291`. **Existing IDs `PL_001`–`PL_290` and their records are never changed.**
3. Validation runs before anything is written: unique IDs, unique normalised names, valid category and country, no ID reuse. If any check fails, nothing is written.
4. Atomic write: the previous `players.json` is backed up, the new file is written to a temp file, then renamed into place. A dry run (`--dry-run`) is the default; `--apply` is required to write.
5. New players get new sets appended per category (for example BAT Set 9 onward), so existing set names and Skip Set behaviour are unchanged.
6. **History is preserved by design.** Every room stores its own copy of the catalogue, so existing and completed rooms (squads, bids, results) are unaffected. Only rooms created after deployment see the new players.
7. **Do not re-run `server/data/buildPlayers.js` after the import.** It assigns IDs by position and would renumber every player. I propose marking it as legacy as part of the import.
8. **Auction length warning:** 441 lots at a 20 s timer plus a 4 s gap is at least about 2.9 hours if every lot goes unsold, and more with bidding. You may want to cap lots per auction or rely on Skip Set. This is a product decision.

## 11. All 179 candidates

| # | Source | Name | Country | Category | Proposal | Detail |
|---|---|---|---|---|---|---|
| 1 | Set 02 | Ajinkya Rahane | India | BAT | Add (new) | IPL 2023, 2025 |
| 2 | Set 02 | Rilee Rossouw | South Africa | BAT | Add (new) | IPL 2023, 2024 |
| 3 | Set 02 | Ripal Patel | India | BAT | Add (new) | IPL 2023 |
| 4 | Set 02 | Priyam Garg | India | BAT | Add (new) | IPL 2023 |
| 5 | Set 02 | Jason Roy | England | BAT | Add (new) | IPL 2023 |
| 6 | Set 02 | Mandeep Singh | India | BAT | Add (new) | IPL 2023 |
| 7 | Set 02 | Jamie Overton | England | BOWL | Add (new) | IPL 2025 |
| 8 | Set 02 | Kulwant Khejroliya | India | BOWL | Add (new) | IPL 2023, 2025 |
| 9 | Set 02 | Ishant Sharma | India | BOWL | Add (new) | IPL 2023, 2025 |
| 10 | Set 02 | Chetan Sakariya | India | BOWL | Add (new) | IPL 2023, 2025 |
| 11 | Set 02 | Mohit Sharma | India | BOWL | Add (new) | IPL 2023, 2025 |
| 12 | Set 02 | Arshad Khan | India | BOWL | Add (new) | IPL 2023, 2024, 2025 |
| 13 | Set 02 | Raghav Goyal | India | SP | Add (new) | IPL 2023 |
| 14 | Set 02 | Hrithik Shokeen | India | SP | Add (new) | IPL 2023 |
| 15 | Set 02 | Piyush Chawla | India | SP | Add (new) | IPL 2023, 2024 |
| 16 | Set 02 | Karan Sharma | India | SP | Manual review | ↔ `PL_145` Karn Sharma |
| 17 | Set 02 | Vijayakanth Viyaskanth | Sri Lanka | SP | Add (new) | IPL 2024 |
| 18 | Set 02 | Aman Hakim Khan | India | AR | Manual review | ↔ `PL_183` Aman Khan |
| 19 | Set 02 | Lalit Yadav | India | AR | Add (new) | IPL 2023 |
| 20 | Set 02 | Matthew Short | Australia | AR | Add (new) | IPL 2023 |
| 21 | Set 02 | Michael Bracewell | New Zealand | AR | Add (new) | IPL 2023 |
| 22 | Set 02 | Abdul Basith | India | AR | Add (new) | IPL 2023 |
| 23 | Set 02 | Mohit Rathee | India | AR | Add (new) | IPL 2023 |
| 24 | Set 02 | Kusal Mendis | Sri Lanka | WK | Add (new) | IPL 2025 |
| 25 | Set 02 | Litton Das | Bangladesh | WK | Add (new) | IPL 2023 |
| 26 | Set 02 | Tom Kohler-Cadmore | England | WK | Add (new) | IPL 2024 |
| 27 | Set 02 | Salil Arora | India | WK | Add (new) | IPL 2026 |
| 28 | Set 02 | Jordan Cox | England | WK | Add (new) | IPL 2026 |
| 29 | Set 02 | Harpreet Singh Bhatia | India | BAT | Add (new) | IPL 2023 |
| 30 | Set 02 | Joe Root | England | BAT | Add (new) | IPL 2023 |
| 31 | Set 02 | Manan Vohra | India | BAT | Add (new) | IPL 2023 |
| 32 | Set 02 | Sherfane Rutherford | West Indies | BAT | Add (new) | IPL 2025 |
| 33 | Set 02 | Tristan Stubbs | South Africa | BAT | Add (new) | IPL 2025 |
| 34 | Set 02 | Sediqullah Atal | Afghanistan | BAT | Add (new) | IPL 2025 |
| 35 | Set 02 | Jason Behrendorff | Australia | BOWL | Add (new) | IPL 2023 |
| 36 | Set 02 | Riley Meredith | Australia | BOWL | Add (new) | IPL 2023 |
| 37 | Set 02 | Duan Jansen | South Africa | BOWL | Add (new) | IPL 2023 |
| 38 | Set 02 | Gurnoor Brar | India | BOWL | Add (new) | IPL 2023 |
| 39 | Set 02 | KM Asif | India | BOWL | Add (new) | IPL 2023 |
| 40 | Set 02 | Obed McCoy | West Indies | BOWL | Add (new) | IPL 2023 |
| 41 | Set 02 | Krishnappa Gowtham | India | AR | Add (new) | IPL 2023, 2024 |
| 42 | Set 02 | Suyash Prabhudessai | India | AR | Add (new) | IPL 2023, 2024 |
| 43 | Set 02 | Prerak Mankad | India | AR | Add (new) | IPL 2023 |
| 44 | Set 02 | Yudhvir Singh | India | AR | Add (new) | IPL 2023, 2024 |
| 45 | Set 02 | Marco Jansen | South Africa | AR | Add (new) | IPL 2023, 2025 |
| 46 | Set 02 | Manoj Bhandage | India | AR | Add (new) | IPL 2025 |
| 47 | Set 02 | Shaik Rasheed | India | BAT | Add (new) | IPL 2025 |
| 48 | Set 02 | Shubham Dubey | India | BAT | Add (new) | IPL 2024, 2025 |
| 49 | Set 02 | Aniket Verma | India | BAT | Add (new) | IPL 2025, 2026 |
| 50 | Set 02 | Saurav Chauhan | India | BAT | Add (new) | IPL 2024 |
| 51 | Set 02 | Ravichandran Smaran | India | BAT | Add (new) | IPL 2026 |
| 52 | Set 02 | Cooper Connolly | Australia | BAT | Add (new) | IPL 2026 |
| 53 | Set 02 | Darshan Nalkande | India | BOWL | Add (new) | IPL 2023, 2024 |
| 54 | Set 02 | Alzarri Joseph | West Indies | BOWL | Add (new) | IPL 2023, 2024 |
| 55 | Set 02 | Arjun Tendulkar | India | BOWL | Add (new) | IPL 2023, 2024 |
| 56 | Set 02 | Jaydev Unadkat | India | BOWL | Add (new) | IPL 2023, 2024, 2025 |
| 57 | Set 02 | Yash Thakur | India | BOWL | Add (new) | IPL 2023, 2024, 2025 |
| 58 | Set 02 | Kwena Maphaka | South Africa | BOWL | Add (new) | IPL 2024 |
| 59 | Set 02 | Jacob Bethell | England | AR | Add (new) | IPL 2025 |
| 60 | Set 02 | Mitchell Owen | Australia | AR | Add (new) | IPL 2025 |
| 61 | Set 02 | Corbin Bosch | South Africa | AR | Add (new) | IPL 2025 |
| 62 | Set 02 | Madhav Tiwari | India | AR | Add (new) | IPL 2025 |
| 63 | Set 02 | Brydon Carse | England | AR | Add (new) | IPL 2025 |
| 64 | Set 02 | Shivang Kumar | India | AR | Add (new) | IPL 2026 |
| 65 | Set 02 | Shamar Joseph | West Indies | BOWL | Add (new) | IPL 2024 |
| 66 | Set 02 | Sandeep Warrier | India | BOWL | Add (new) | IPL 2024 |
| 67 | Set 02 | Luke Wood | England | BOWL | Add (new) | IPL 2024 |
| 68 | Set 02 | Nuwan Thushara | Sri Lanka | BOWL | Add (new) | IPL 2024, 2025 |
| 69 | Set 02 | Vidwath Kaverappa | India | BOWL | Add (new) | IPL 2024 |
| 70 | Set 02 | Xavier Bartlett | Australia | BOWL | Add (new) | IPL 2025 |
| 71 | Set 02 | Harsh Dubey | India | AR | Add (new) | IPL 2025, 2026 |
| 72 | Set 02 | Reece Topley | England | BOWL | Add (new) | IPL 2024, 2025 |
| 73 | Set 02 | Richard Gleeson | England | BOWL | Add (new) | IPL 2024, 2025 |
| 74 | Set 02 | Ashwani Kumar | India | BOWL | Add (new) | IPL 2025, 2026 |
| 75 | Set 02 | Eshan Malinga | Sri Lanka | BOWL | Add (new) | IPL 2025, 2026 |
| 76 | Set 02 | Praful Hinge | India | BOWL | Add (new) | IPL 2026 |
| 77 | Set 02 | David Payne | England | BOWL | Add (new) | IPL 2026 |
| 78 | Set 02 | Satyanarayana Raju | India | BOWL | Add (new) | IPL 2025 |
| 79 | Set 02 | Kuldip Yadav | India | BOWL | Add (new) | IPL 2023 |
| 80 | Set 03 | Ambati Rayudu | India | BAT | Add (new) | IPL appearance · 2022 |
| 81 | Set 03 | Robin Uthappa | India | BAT | Add (new) | IPL appearance · 2022 |
| 82 | Set 03 | David Warner | Australia | BAT | Add (new) | IPL appearance · 2022 |
| 83 | Set 03 | Chris Jordan | England | BOWL | Add (new) | IPL appearance · 2022 |
| 84 | Set 03 | Mukesh Choudhary | India | BOWL | Add (new) | IPL appearance · 2022 |
| 85 | Set 03 | Kamlesh Nagarkoti | India | BOWL | Add (new) | IPL appearance · 2022 |
| 86 | Set 03 | Pradeep Sangwan | India | BOWL | Add (new) | IPL appearance · 2022 |
| 87 | Set 03 | Kumar Kartikeya | India | SP | Add (new) | IPL appearance · 2022 |
| 88 | Set 03 | Dwaine Pretorius | South Africa | AR | Add (new) | IPL appearance · 2022 |
| 89 | Set 03 | Dwayne Bravo | West Indies | AR | Add (new) | IPL appearance · 2022 |
| 90 | Set 03 | Devon Conway | New Zealand | WK | Add (new) | IPL appearance · 2022 |
| 91 | Set 03 | KS Bharat | India | WK | Add (new) | IPL appearance · 2022 |
| 92 | Set 03 | Aaron Finch | Australia | BAT | Add (new) | IPL appearance · 2022 |
| 93 | Set 03 | Abhijeet Tomar | India | BAT | Add (new) | IPL appearance · 2022 |
| 94 | Set 03 | Ayush Badoni | India | BAT | Add (new) | IPL appearance · 2022 |
| 95 | Set 03 | Varun Aaron | India | BOWL | Add (new) | IPL appearance · 2022 |
| 96 | Set 03 | Rasikh Salam | India | BOWL | Manual review | ↔ `PL_252` Rasikh Dar |
| 97 | Set 03 | Tim Southee | New Zealand | BOWL | Add (new) | IPL appearance · 2022 |
| 98 | Set 03 | Andrew Tye | Australia | BOWL | Add (new) | IPL appearance · 2022 |
| 99 | Set 03 | Ravichandran Ashwin | India | SP | Add (new) | IPL appearance · 2022 |
| 100 | Set 03 | Kieron Pollard | West Indies | AR | Add (new) | IPL appearance · 2022 |
| 101 | Set 03 | Fabian Allen | West Indies | AR | Add (new) | IPL appearance · 2022 |
| 102 | Set 03 | Wriddhiman Saha | India | WK | Add (new) | IPL appearance · 2022 |
| 103 | Set 03 | Matthew Wade | Australia | WK | Add (new) | IPL appearance · 2022 |
| 104 | Set 03 | Evin Lewis | West Indies | BAT | Add (new) | IPL appearance · 2022 |
| 105 | Set 03 | Shikhar Dhawan | India | BAT | Add (new) | IPL appearance · 2022 |
| 106 | Set 03 | Bhanuka Rajapaksa | Sri Lanka | BAT | Add (new) | IPL appearance · 2022 |
| 107 | Set 03 | Basil Thampi | India | BOWL | Add (new) | IPL appearance · 2022 |
| 108 | Set 03 | Tymal Mills | England | BOWL | Add (new) | IPL appearance · 2022 |
| 109 | Set 03 | Nathan Coulter-Nile | Australia | BOWL | Add (new) | IPL appearance · 2022 |
| 110 | Set 03 | Kuldeep Sen | India | BOWL | Add (new) | IPL appearance · 2022 |
| 111 | Set 03 | Amit Mishra | India | SP | Add (new) | IPL appearance · 2023 |
| 112 | Set 03 | Sanjay Yadav | India | AR | Add (new) | IPL appearance · 2022 |
| 113 | Set 03 | Odean Smith | West Indies | AR | Add (new) | IPL appearance · 2022 |
| 114 | Set 03 | Sam Billings | England | WK | Add (new) | IPL appearance · 2022 |
| 115 | Set 03 | Sheldon Jackson | India | WK | Add (new) | IPL appearance · 2022 |
| 116 | Set 03 | Rassie van der Dussen | South Africa | BAT | Add (new) | IPL appearance · 2022 |
| 117 | Set 03 | Kane Williamson | New Zealand | BAT | Add (new) | IPL appearance · 2022 |
| 118 | Set 03 | Kedar Jadhav | India | BAT | Add (new) | IPL appearance · 2023 |
| 119 | Set 03 | Siddarth Kaul | India | BOWL | Add (new) | IPL appearance · 2022 |
| 120 | Set 03 | Sean Abbott | Australia | BOWL | Add (new) | IPL appearance · 2022 |
| 121 | Set 03 | Akash Singh | India | BOWL | Add (new) | IPL appearance · 2023 |
| 122 | Set 03 | Sisanda Magala | South Africa | BOWL | Add (new) | IPL appearance · 2023 |
| 123 | Set 03 | Adil Rashid | England | SP | Add (new) | IPL appearance · 2023 |
| 124 | Set 03 | David Willey | England | AR | Add (new) | IPL appearance · 2022 |
| 125 | Set 03 | Abhishek Sharma | India | AR | Add (new) | IPL appearance · 2022 |
| 126 | Set 03 | Baba Indrajith | India | WK | Add (new) | IPL appearance · 2022 |
| 127 | Set 03 | Dinesh Karthik | India | WK | Add (new) | IPL appearance · 2022 |
| 128 | Set 03 | Vivrant Sharma | India | BAT | Add (new) | IPL appearance · 2023 |
| 129 | Set 03 | Vaibhav Suryavanshi | India | BAT | Skip: duplicate (high) | ↔ `PL_167` Vaibhav Sooryavanshi |
| 130 | Set 03 | Joshua Little | Ireland | BOWL | Add (new) | IPL appearance · 2023 |
| 131 | Set 03 | Mark Wood | England | BOWL | Add (new) | IPL appearance · 2023 |
| 132 | Set 03 | Vyshak Vijay Kumar | India | BOWL | Skip: duplicate (high) | ↔ `PL_253` Vijaykumar Vyshak |
| 133 | Set 03 | Wayne Parnell | South Africa | BOWL | Add (new) | IPL appearance · 2023 |
| 134 | Set 03 | Vignesh Puthur | India | SP | Add (new) | IPL appearance · 2025 |
| 135 | Set 03 | Sanvir Singh | India | AR | Add (new) | IPL appearance · 2023 |
| 136 | Set 03 | David Wiese | Namibia | AR | Add (new) | IPL appearance · 2023 |
| 137 | Set 03 | Philip Salt | England | WK | Skip: duplicate (high) | ↔ `PL_040` Phil Salt |
| 138 | Set 03 | Abishek Porel | India | WK | Skip: duplicate (high) | ↔ `PL_113` Abhishek Porel |
| 139 | Set 03 | Ashton Turner | Australia | BAT | Add (new) | IPL appearance · 2024 |
| 140 | Set 03 | Himmat Singh | India | BAT | Add (new) | IPL appearance · 2025 |
| 141 | Set 03 | Auqib Nabi Dar | India | BOWL | Skip: duplicate (high) | ↔ `PL_255` Auqib Nabi |
| 142 | Set 03 | Lizaad Williams | South Africa | BOWL | Add (new) | IPL appearance · 2024 |
| 143 | Set 03 | Jhye Richardson | Australia | BOWL | Add (new) | IPL appearance · 2024 |
| 144 | Set 03 | Digvesh Rathi | India | SP | Skip: duplicate (high) | ↔ `PL_187` Digvesh Singh Rathi |
| 145 | Set 03 | Gulbadin Naib | Afghanistan | AR | Add (new) | IPL appearance · 2024 |
| 146 | Set 03 | Sumit Kumar | India | AR | Add (new) | IPL appearance · 2024 |
| 147 | Set 03 | BR Sharath | India | WK | Hold: incomplete name | IPL appearance · 2024 |
| 148 | Set 03 | Sachin Baby | India | BAT | Add (new) | IPL appearance · 2025 |
| 149 | Set 03 | SU Parakh | India | BAT | Hold: incomplete name | IPL appearance · 2026 |
| 150 | Set 03 | William O'Rourke | New Zealand | BOWL | Add (new) | IPL appearance · 2025 |
| 151 | Set 03 | Kyle Jamieson | New Zealand | BOWL | Add (new) | IPL appearance · 2025 |
| 152 | Set 03 | Abhinandan Singh | India | BOWL | Add (new) | IPL appearance · 2025 |
| 153 | Set 03 | Allah Mohammad Ghazanfar | Afghanistan | SP | Add (new) | IPL appearance · 2026 |
| 154 | Set 03 | Gulbudeen Naib | Afghanistan | AR | Skip: internal duplicate | = Gulbadin Naib |
| 155 | Set 03 | T Dahiya | India | WK | Manual review | ↔ `PL_233` Tejasvi Dahiya |
| 156 | Set 03 | Akshat Raghuwanshi | India | BAT | Add (new) | IPL appearance · 2026 |
| 157 | Set 03 | DV Malewar | India | BAT | Hold: incomplete name | IPL appearance · 2026 |
| 158 | Set 03 | Ashok Sharma | India | BOWL | Add (new) | IPL appearance · 2026 |
| 159 | Set 03 | Tripurana Vijay | India | BOWL | Add (new) | IPL appearance · 2026 |
| 160 | Set 03 | RS Ghosh | India | BOWL | Hold: incomplete name | IPL appearance · 2026 |
| 161 | Set 03 | Raghu Sharma | India | SP | Add (new) | IPL appearance · 2026 |
| 162 | Set 03 | Yuvraj Chaudhary | India | AR | Policy: domestic prospect | Domestic prospect · 2025 squad · no IPL match confirmed |
| 163 | Set 03 | LG Pretorius | South Africa | WK | Manual review | ↔ `PL_194` Lhuan-dre Pretorius |
| 164 | Set 03 | Pyla Avinash | India | BAT | Policy: domestic prospect | Domestic prospect · 2025 squad · no IPL match confirmed |
| 165 | Set 03 | Andre Siddarth | India | BAT | Policy: domestic prospect | Domestic prospect · 2025 squad · no IPL match confirmed |
| 166 | Set 03 | Saurabh Dubey | India | BOWL | Add (new) | IPL appearance · 2026 |
| 167 | Set 03 | Krish Bhagat | India | BOWL | Add (new) | IPL appearance · 2026 |
| 168 | Set 03 | Ben Dwarshuis | Australia | BOWL | Add (new) | IPL appearance · 2025 |
| 169 | Set 03 | Tejas Baroka | India | SP | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 170 | Set 03 | Aneeshwar Gautam | India | AR | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 171 | Set 03 | Kunal Rathore | India | WK | Policy: domestic prospect | Domestic prospect · 2025 squad · no IPL match confirmed |
| 172 | Set 03 | Pratham Singh | India | BAT | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 173 | Set 03 | Shubham Garhwal | India | BAT | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 174 | Set 03 | Brijesh Sharma | India | BOWL | Add (new) | IPL appearance · 2026 |
| 175 | Set 03 | Sushant Mishra | India | BOWL | Add (new) | IPL appearance · 2026 |
| 176 | Set 03 | Anunay Singh | India | BOWL | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 177 | Set 03 | Ansh Patel | India | SP | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 178 | Set 03 | Ramesh Kumar | India | AR | Policy: domestic prospect | Domestic prospect · 2022 squad · no IPL match confirmed |
| 179 | Set 03 | Krishnan Shrijith | India | WK | Policy: domestic prospect | Domestic prospect · 2025 squad · no IPL match confirmed |

## 12. Decisions needed from you

1. Confirm or reject the 6 high-confidence duplicates (§3) and decide the 5 medium-confidence cases (§4).
2. Confirm that Gulbadin Naib should be imported once (§5).
3. Provide full names for, or exclude, SU Parakh, DV Malewar, RS Ghosh and BR Sharath (§6).
4. Include or exclude the 12 domestic prospects (§7), and any retired players (§9).
5. Set the base-price policy for new players (§9).
6. Approve the import procedure (§10). Nothing is written until you do.
