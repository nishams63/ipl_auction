// Script to build the official player dataset from the 300 candidate entries
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// All 10 rounds, 5 sets per round, 6 players per set = 300 cards
const rawRounds = [
  // Round 01
  {
    round: 1,
    sets: [
      {
        category: "BAT", code: "BAT-01", title: "BATTERS",
        players: [
          { name: "Virat Kohli", country: "India", basePrice: 2.0, rating: 98, role: "Top-order Batter", stats: { matches: 252, runs: 8004, sr: 131.9, hs: "113*" } },
          { name: "Travis Head", country: "Australia", basePrice: 2.0, rating: 94, role: "Opening Batter", stats: { matches: 26, runs: 796, sr: 178.5, hs: "102" } },
          { name: "Rohit Sharma", country: "India", basePrice: 2.0, rating: 96, role: "Opening Batter", stats: { matches: 257, runs: 6628, sr: 131.1, hs: "109*" } },
          { name: "David Miller", country: "South Africa", basePrice: 1.5, rating: 90, role: "Middle-order Finisher", stats: { matches: 130, runs: 2924, sr: 139.2, hs: "101*" } },
          { name: "Shubman Gill", country: "India", basePrice: 2.0, rating: 95, role: "Top-order Batter", stats: { matches: 103, runs: 3216, sr: 135.7, hs: "129" } },
          { name: "Harry Brook", country: "England", basePrice: 1.5, rating: 88, role: "Middle-order Batter", stats: { matches: 11, runs: 190, sr: 123.4, hs: "100*" } }
        ]
      },
      {
        category: "FAST", code: "FAST-01", title: "FAST BOWLERS",
        players: [
          { name: "Jasprit Bumrah", country: "India", basePrice: 2.0, rating: 99, role: "Right-arm Fast Bowler", stats: { matches: 133, wickets: 165, econ: 7.30, bbi: "5/10" } },
          { name: "Mitchell Starc", country: "Australia", basePrice: 2.0, rating: 95, role: "Left-arm Fast Bowler", stats: { matches: 41, wickets: 51, econ: 8.21, bbi: "4/15" } },
          { name: "Mohammed Siraj", country: "India", basePrice: 2.0, rating: 91, role: "Right-arm Fast Bowler", stats: { matches: 93, wickets: 93, econ: 8.65, bbi: "4/21" } },
          { name: "Pat Cummins", country: "Australia", basePrice: 2.0, rating: 94, role: "Right-arm Fast Bowler", stats: { matches: 58, wickets: 63, econ: 8.86, bbi: "4/34" } },
          { name: "Arshdeep Singh", country: "India", basePrice: 2.0, rating: 92, role: "Left-arm Fast Bowler", stats: { matches: 65, wickets: 76, econ: 8.74, bbi: "5/32" } },
          { name: "Josh Hazlewood", country: "Australia", basePrice: 2.0, rating: 92, role: "Right-arm Fast Bowler", stats: { matches: 27, wickets: 35, econ: 8.06, bbi: "4/25" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-01", title: "SPIN BOWLERS",
        players: [
          { name: "Kuldeep Yadav", country: "India", basePrice: 2.0, rating: 94, role: "Left-arm Wrist Spinner", stats: { matches: 84, wickets: 87, econ: 8.12, bbi: "4/14" } },
          { name: "Rashid Khan", country: "Afghanistan", basePrice: 2.0, rating: 98, role: "Right-arm Leg Spinner", stats: { matches: 121, wickets: 149, econ: 6.82, bbi: "4/24" } },
          { name: "Yuzvendra Chahal", country: "India", basePrice: 2.0, rating: 95, role: "Right-arm Leg Spinner", stats: { matches: 160, wickets: 205, econ: 7.84, bbi: "5/40" } },
          { name: "Noor Ahmad", country: "Afghanistan", basePrice: 1.5, rating: 89, role: "Left-arm Wrist Spinner", stats: { matches: 23, wickets: 24, econ: 8.04, bbi: "3/37" } },
          { name: "Ravi Bishnoi", country: "India", basePrice: 1.5, rating: 91, role: "Right-arm Leg Spinner", stats: { matches: 66, wickets: 63, econ: 7.81, bbi: "3/24" } },
          { name: "Sunil Narine", country: "West Indies", basePrice: 2.0, rating: 97, role: "Right-arm Mystery Spinner", stats: { matches: 177, wickets: 180, econ: 6.73, bbi: "5/19" } }
        ]
      },
      {
        category: "AR", code: "AR-01", title: "ALL-ROUNDERS",
        players: [
          { name: "Hardik Pandya", country: "India", basePrice: 2.0, rating: 96, role: "Pace All-Rounder", stats: { matches: 137, runs: 2525, wickets: 64, sr: 144.8 } },
          { name: "Andre Russell", country: "West Indies", basePrice: 2.0, rating: 96, role: "Power-hitting Pace All-Rounder", stats: { matches: 127, runs: 2484, wickets: 115, sr: 174.9 } },
          { name: "Shivam Dube", country: "India", basePrice: 2.0, rating: 92, role: "Batting All-Rounder (Spin Destroyer)", stats: { matches: 65, runs: 1502, wickets: 5, sr: 159.2 } },
          { name: "Glenn Maxwell", country: "Australia", basePrice: 2.0, rating: 93, role: "Off-spin All-Rounder", stats: { matches: 134, runs: 2771, wickets: 37, sr: 156.7 } },
          { name: "Nitish Kumar Reddy", country: "India", basePrice: 1.5, rating: 90, role: "Medium-pace All-Rounder", stats: { matches: 15, runs: 303, wickets: 3, sr: 142.9 } },
          { name: "Marcus Stoinis", country: "Australia", basePrice: 2.0, rating: 92, role: "Pace All-Rounder", stats: { matches: 96, runs: 1866, wickets: 43, sr: 142.0 } }
        ]
      },
      {
        category: "WK", code: "WK-01", title: "WICKETKEEPERS",
        players: [
          { name: "MS Dhoni", country: "India", basePrice: 2.0, rating: 97, role: "Wicketkeeper Batter & Legend", stats: { matches: 264, runs: 5243, dis: 190, sr: 137.5 } },
          { name: "Jos Buttler", country: "England", basePrice: 2.0, rating: 97, role: "Wicketkeeper Opening Batter", stats: { matches: 107, runs: 3582, dis: 72, sr: 147.5 } },
          { name: "Sanju Samson", country: "India", basePrice: 2.0, rating: 95, role: "Wicketkeeper Top-order Batter", stats: { matches: 167, runs: 4419, dis: 96, sr: 138.9 } },
          { name: "Nicholas Pooran", country: "West Indies", basePrice: 2.0, rating: 95, role: "Wicketkeeper Power Batter", stats: { matches: 76, runs: 1769, dis: 38, sr: 162.3 } },
          { name: "Rishabh Pant", country: "India", basePrice: 2.0, rating: 96, role: "Wicketkeeper Middle-order Batter", stats: { matches: 111, runs: 3284, dis: 92, sr: 148.9 } },
          { name: "Quinton de Kock", country: "South Africa", basePrice: 2.0, rating: 93, role: "Wicketkeeper Opening Batter", stats: { matches: 107, runs: 3157, dis: 95, sr: 134.2 } }
        ]
      }
    ]
  },
  // Round 02
  {
    round: 2,
    sets: [
      {
        category: "BAT", code: "BAT-02", title: "BATTERS",
        players: [
          { name: "Yashasvi Jaiswal", country: "India", basePrice: 2.0, rating: 95, role: "Opening Batter", stats: { matches: 52, runs: 1607, sr: 150.6, hs: "124" } },
          { name: "Aiden Markram", country: "South Africa", basePrice: 1.5, rating: 89, role: "Middle-order Batter", stats: { matches: 44, runs: 995, sr: 129.2, hs: "68*" } },
          { name: "Suryakumar Yadav", country: "India", basePrice: 2.0, rating: 98, role: "360° Middle-order Batter", stats: { matches: 150, runs: 3594, sr: 145.3, hs: "103*" } },
          { name: "Dewald Brevis", country: "South Africa", basePrice: 1.0, rating: 86, role: "Attacking Top-order Batter", stats: { matches: 10, runs: 230, sr: 142.0, hs: "49" } },
          { name: "Ruturaj Gaikwad", country: "India", basePrice: 2.0, rating: 94, role: "Opening Batter & Captain", stats: { matches: 66, runs: 2380, sr: 136.9, hs: "108*" } },
          { name: "Rachin Ravindra", country: "New Zealand", basePrice: 1.5, rating: 89, role: "Top-order Batter", stats: { matches: 10, runs: 222, sr: 160.9, hs: "61" } }
        ]
      },
      {
        category: "FAST", code: "FAST-02", title: "FAST BOWLERS",
        players: [
          { name: "Bhuvneshwar Kumar", country: "India", basePrice: 1.5, rating: 91, role: "Swing Specialist Fast Bowler", stats: { matches: 176, wickets: 181, econ: 7.56, bbi: "5/19" } },
          { name: "Jofra Archer", country: "England", basePrice: 2.0, rating: 93, role: "Express Fast Bowler", stats: { matches: 40, wickets: 48, econ: 7.43, bbi: "3/15" } },
          { name: "Mohammed Shami", country: "India", basePrice: 2.0, rating: 95, role: "Seam & Swing Fast Bowler", stats: { matches: 110, wickets: 127, econ: 8.44, bbi: "4/11" } },
          { name: "Trent Boult", country: "New Zealand", basePrice: 2.0, rating: 94, role: "Left-arm Powerplay Specialist", stats: { matches: 104, wickets: 121, econ: 8.29, bbi: "4/18" } },
          { name: "Prasidh Krishna", country: "India", basePrice: 1.5, rating: 88, role: "Hit-the-deck Fast Bowler", stats: { matches: 51, wickets: 49, econ: 8.92, bbi: "4/30" } },
          { name: "Lockie Ferguson", country: "New Zealand", basePrice: 1.5, rating: 90, role: "Express Fast Bowler (150+ km/h)", stats: { matches: 45, wickets: 46, econ: 8.87, bbi: "4/28" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-02", title: "SPIN BOWLERS",
        players: [
          { name: "Varun Chakravarthy", country: "India", basePrice: 2.0, rating: 93, role: "Mystery Spinner", stats: { matches: 70, wickets: 83, econ: 7.55, bbi: "5/20" } },
          { name: "Wanindu Hasaranga", country: "Sri Lanka", basePrice: 1.5, rating: 92, role: "Leg-spinner & Googly Master", stats: { matches: 26, wickets: 35, econ: 8.13, bbi: "5/18" } },
          { name: "Rahul Chahar", country: "India", basePrice: 1.0, rating: 88, role: "Right-arm Leg Spinner", stats: { matches: 79, wickets: 75, econ: 7.72, bbi: "4/27" } },
          { name: "Maheesh Theekshana", country: "Sri Lanka", basePrice: 1.5, rating: 89, role: "Finger Mystery Spinner", stats: { matches: 27, wickets: 25, econ: 7.66, bbi: "4/33" } },
          { name: "Suyash Sharma", country: "India", basePrice: 0.5, rating: 85, role: "Right-arm Leg Spinner", stats: { matches: 13, wickets: 10, econ: 8.52, bbi: "3/30" } },
          { name: "Mujeeb Ur Rahman", country: "Afghanistan", basePrice: 1.0, rating: 87, role: "Right-arm Off-break", stats: { matches: 19, wickets: 19, econ: 8.18, bbi: "3/27" } }
        ]
      },
      {
        category: "AR", code: "AR-02", title: "ALL-ROUNDERS",
        players: [
          { name: "Riyan Parag", country: "India", basePrice: 1.5, rating: 92, role: "Batting All-Rounder / Off-spin", stats: { matches: 69, runs: 1173, wickets: 4, sr: 135.2 } },
          { name: "Cameron Green", country: "Australia", basePrice: 2.0, rating: 93, role: "Pace All-Rounder", stats: { matches: 29, runs: 707, wickets: 16, sr: 153.7 } },
          { name: "Venkatesh Iyer", country: "India", basePrice: 1.5, rating: 90, role: "Batting All-Rounder", stats: { matches: 51, runs: 1326, wickets: 3, sr: 137.1 } },
          { name: "Liam Livingstone", country: "England", basePrice: 1.5, rating: 91, role: "Spin All-Rounder (Leg & Off-spin)", stats: { matches: 39, runs: 939, wickets: 11, sr: 162.5 } },
          { name: "Krunal Pandya", country: "India", basePrice: 1.5, rating: 89, role: "Left-arm Spin All-Rounder", stats: { matches: 127, runs: 1647, wickets: 76, sr: 133.4 } },
          { name: "Sam Curran", country: "England", basePrice: 2.0, rating: 92, role: "Left-arm Swing All-Rounder", stats: { matches: 59, runs: 883, wickets: 58, sr: 143.1 } }
        ]
      },
      {
        category: "WK", code: "WK-02", title: "WICKETKEEPERS",
        players: [
          { name: "KL Rahul", country: "India", basePrice: 2.0, rating: 95, role: "Wicketkeeper Opening Batter", stats: { matches: 132, runs: 4683, dis: 75, sr: 134.6 } },
          { name: "Phil Salt", country: "England", basePrice: 1.5, rating: 92, role: "Aggressive Wicketkeeper Batter", stats: { matches: 21, runs: 653, dis: 16, sr: 175.5 } },
          { name: "Ishan Kishan", country: "India", basePrice: 2.0, rating: 93, role: "Wicketkeeper Dynamic Opener", stats: { matches: 105, runs: 2644, dis: 54, sr: 135.9 } },
          { name: "Heinrich Klaasen", country: "South Africa", basePrice: 2.0, rating: 97, role: "Wicketkeeper Power Finisher", stats: { matches: 35, runs: 993, dis: 22, sr: 168.3 } },
          { name: "Jitesh Sharma", country: "India", basePrice: 1.0, rating: 88, role: "Wicketkeeper Finisher", stats: { matches: 40, runs: 730, dis: 29, sr: 151.1 } },
          { name: "Ryan Rickelton", country: "South Africa", basePrice: 1.0, rating: 87, role: "Wicketkeeper Top-order Batter", stats: { matches: 8, runs: 210, dis: 9, sr: 144.8 } }
        ]
      }
    ]
  },
  // Round 03
  {
    round: 3,
    sets: [
      {
        category: "BAT", code: "BAT-03", title: "BATTERS",
        players: [
          { name: "Shreyas Iyer", country: "India", basePrice: 2.0, rating: 94, role: "Top-order Anchor & Captain", stats: { matches: 115, runs: 3127, sr: 127.5, hs: "96" } },
          { name: "Steve Smith", country: "Australia", basePrice: 1.5, rating: 88, role: "Top-order Tactician", stats: { matches: 103, runs: 2485, sr: 128.1, hs: "101" } },
          { name: "Rinku Singh", country: "India", basePrice: 1.5, rating: 93, role: "Clutch Finisher", stats: { matches: 46, runs: 893, sr: 143.3, hs: "67*" } },
          { name: "Jake Fraser-McGurk", country: "Australia", basePrice: 1.5, rating: 91, role: "Explosive Opener", stats: { matches: 9, runs: 330, sr: 234.0, hs: "84" } },
          { name: "Tilak Varma", country: "India", basePrice: 1.5, rating: 92, role: "Middle-order Anchor", stats: { matches: 38, runs: 1156, sr: 146.3, hs: "84*" } },
          { name: "Shimron Hetmyer", country: "West Indies", basePrice: 1.5, rating: 90, role: "Death Overs Finisher", stats: { matches: 72, runs: 1243, sr: 153.3, hs: "75" } }
        ]
      },
      {
        category: "FAST", code: "FAST-03", title: "FAST BOWLERS",
        players: [
          { name: "Harshal Patel", country: "India", basePrice: 2.0, rating: 92, role: "Purple Cap Death Specialist", stats: { matches: 105, wickets: 135, econ: 8.59, bbi: "5/27" } },
          { name: "Kagiso Rabada", country: "South Africa", basePrice: 2.0, rating: 94, role: "Pace & Bounce Fast Bowler", stats: { matches: 80, wickets: 117, econ: 8.42, bbi: "4/21" } },
          { name: "T Natarajan", country: "India", basePrice: 1.5, rating: 90, role: "Left-arm Yorker Specialist", stats: { matches: 61, wickets: 67, econ: 8.83, bbi: "4/19" } },
          { name: "Anrich Nortje", country: "South Africa", basePrice: 1.5, rating: 91, role: "Express Fast Bowler", stats: { matches: 46, wickets: 60, econ: 8.96, bbi: "3/33" } },
          { name: "Avesh Khan", country: "India", basePrice: 1.5, rating: 89, role: "Right-arm Fast Medium", stats: { matches: 63, wickets: 75, econ: 8.84, bbi: "4/24" } },
          { name: "Gerald Coetzee", country: "South Africa", basePrice: 1.5, rating: 89, role: "Aggressive Fast Bowler", stats: { matches: 10, wickets: 13, econ: 10.18, bbi: "4/34" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-03", title: "SPIN BOWLERS",
        players: [
          { name: "Mayank Markande", country: "India", basePrice: 0.75, rating: 86, role: "Right-arm Leg Spinner", stats: { matches: 37, wickets: 37, econ: 8.53, bbi: "4/15" } },
          { name: "Akeal Hosein", country: "West Indies", basePrice: 1.0, rating: 87, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 6.00, bbi: "1/24" } },
          { name: "R Sai Kishore", country: "India", basePrice: 0.75, rating: 88, role: "Slow Left-arm Orthodox", stats: { matches: 10, wickets: 13, econ: 8.33, bbi: "4/33" } },
          { name: "Adam Zampa", country: "Australia", basePrice: 1.5, rating: 91, role: "Right-arm Leg Spinner", stats: { matches: 20, wickets: 29, econ: 7.99, bbi: "6/19" } },
          { name: "Manav Suthar", country: "India", basePrice: 0.3, rating: 82, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 0, econ: 8.00, bbi: "0/16" } },
          { name: "Tabraiz Shamsi", country: "South Africa", basePrice: 1.0, rating: 87, role: "Left-arm Unorthodox Chinaman", stats: { matches: 5, wickets: 4, econ: 8.65, bbi: "1/21" } }
        ]
      },
      {
        category: "AR", code: "AR-03", title: "ALL-ROUNDERS",
        players: [
          { name: "Deepak Hooda", country: "India", basePrice: 1.0, rating: 86, role: "Batting All-Rounder (Off-spin)", stats: { matches: 118, runs: 1475, wickets: 10, sr: 129.5 } },
          { name: "Moeen Ali", country: "England", basePrice: 1.5, rating: 90, role: "Off-spin All-Rounder", stats: { matches: 67, runs: 1162, wickets: 35, sr: 143.0 } },
          { name: "Vijay Shankar", country: "India", basePrice: 0.75, rating: 85, role: "Medium-pace All-Rounder", stats: { matches: 72, runs: 1115, wickets: 9, sr: 129.8 } },
          { name: "Mitchell Marsh", country: "Australia", basePrice: 2.0, rating: 92, role: "Pace All-Rounder", stats: { matches: 42, runs: 666, wickets: 37, sr: 132.7 } },
          { name: "Ramandeep Singh", country: "India", basePrice: 0.75, rating: 87, role: "Finisher & Medium Pacer", stats: { matches: 20, runs: 170, wickets: 6, sr: 179.0 } },
          { name: "Will Jacks", country: "England", basePrice: 1.5, rating: 91, role: "Power Batter & Off-spinner", stats: { matches: 8, runs: 230, wickets: 2, sr: 175.6 } }
        ]
      },
      {
        category: "WK", code: "WK-03", title: "WICKETKEEPERS",
        players: [
          { name: "Dhruv Jurel", country: "India", basePrice: 1.5, rating: 90, role: "Wicketkeeper Middle-order Batter", stats: { matches: 28, runs: 347, dis: 15, sr: 151.5 } },
          { name: "Jonny Bairstow", country: "England", basePrice: 1.5, rating: 91, role: "Wicketkeeper Aggressive Opener", stats: { matches: 50, runs: 1589, dis: 26, sr: 144.4 } },
          { name: "Prabhsimran Singh", country: "India", basePrice: 1.0, rating: 88, role: "Wicketkeeper Opener", stats: { matches: 34, runs: 756, dis: 14, sr: 150.9 } },
          { name: "Rahmanullah Gurbaz", country: "Afghanistan", basePrice: 1.0, rating: 88, role: "Wicketkeeper Opener", stats: { matches: 13, runs: 289, dis: 10, sr: 133.8 } },
          { name: "Abhishek Porel", country: "India", basePrice: 0.75, rating: 87, role: "Wicketkeeper Left-hand Batter", stats: { matches: 18, runs: 360, dis: 9, sr: 154.5 } },
          { name: "Finn Allen", country: "New Zealand", basePrice: 1.0, rating: 89, role: "Wicketkeeper Top-order Powerhouse", stats: { matches: 4, runs: 90, dis: 2, sr: 165.0 } }
        ]
      }
    ]
  },
  // Round 04
  {
    round: 4,
    sets: [
      {
        category: "BAT", code: "BAT-04", title: "BATTERS",
        players: [
          { name: "Sai Sudharsan", country: "India", basePrice: 1.5, rating: 91, role: "Top-order Left-hand Batter", stats: { matches: 25, runs: 1034, sr: 139.2, hs: "103" } },
          { name: "Pathum Nissanka", country: "Sri Lanka", basePrice: 1.0, rating: 87, role: "Opening Anchor", stats: { matches: 8, runs: 240, sr: 130.5, hs: "72" } },
          { name: "Devdutt Padikkal", country: "India", basePrice: 1.0, rating: 87, role: "Top-order Left-hand Batter", stats: { matches: 65, runs: 1560, sr: 122.9, hs: "101*" } },
          { name: "Charith Asalanka", country: "Sri Lanka", basePrice: 1.0, rating: 86, role: "Middle-order Batter", stats: { matches: 6, runs: 135, sr: 126.2, hs: "45" } },
          { name: "Prithvi Shaw", country: "India", basePrice: 1.0, rating: 88, role: "Explosive Opening Batter", stats: { matches: 79, runs: 1892, sr: 147.5, hs: "99" } },
          { name: "Kusal Perera", country: "Sri Lanka", basePrice: 1.0, rating: 86, role: "Aggressive Opener / Keeper", stats: { matches: 18, runs: 340, sr: 134.8, hs: "66" } }
        ]
      },
      {
        category: "FAST", code: "FAST-04", title: "FAST BOWLERS",
        players: [
          { name: "Deepak Chahar", country: "India", basePrice: 1.5, rating: 89, role: "Right-arm Swing Bowler", stats: { matches: 81, wickets: 77, econ: 7.97, bbi: "4/13" } },
          { name: "Matheesha Pathirana", country: "Sri Lanka", basePrice: 1.5, rating: 93, role: "Right-arm Slinger & Yorker King", stats: { matches: 20, wickets: 34, econ: 7.88, bbi: "4/28" } },
          { name: "Khaleel Ahmed", country: "India", basePrice: 1.5, rating: 89, role: "Left-arm Fast Medium", stats: { matches: 57, wickets: 74, econ: 8.79, bbi: "3/21" } },
          { name: "Mustafizur Rahman", country: "Bangladesh", basePrice: 1.5, rating: 91, role: "Left-arm Cutter Specialist", stats: { matches: 57, wickets: 61, econ: 7.93, bbi: "4/29" } },
          { name: "Mukesh Kumar", country: "India", basePrice: 1.0, rating: 88, role: "Right-arm Medium Fast", stats: { matches: 20, wickets: 24, econ: 9.87, bbi: "3/14" } },
          { name: "Fazalhaq Farooqi", country: "Afghanistan", basePrice: 1.0, rating: 88, role: "Left-arm Swing Bowler", stats: { matches: 7, wickets: 6, econ: 8.64, bbi: "3/11" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-04", title: "SPIN BOWLERS",
        players: [
          { name: "Shreyas Gopal", country: "India", basePrice: 0.5, rating: 84, role: "Right-arm Leg Spinner", stats: { matches: 52, wickets: 52, econ: 8.11, bbi: "4/16" } },
          { name: "Keshav Maharaj", country: "South Africa", basePrice: 1.0, rating: 88, role: "Left-arm Orthodox", stats: { matches: 2, wickets: 2, econ: 6.50, bbi: "2/23" } },
          { name: "Praveen Dubey", country: "India", basePrice: 0.4, rating: 82, role: "Right-arm Leg Spinner", stats: { matches: 5, wickets: 2, econ: 8.75, bbi: "1/19" } },
          { name: "Gudakesh Motie", country: "West Indies", basePrice: 1.0, rating: 87, role: "Left-arm Orthodox", stats: { matches: 4, wickets: 5, econ: 7.20, bbi: "3/22" } },
          { name: "Murugan Ashwin", country: "India", basePrice: 0.5, rating: 84, role: "Right-arm Leg Spinner", stats: { matches: 44, wickets: 35, econ: 7.99, bbi: "3/21" } },
          { name: "Ish Sodhi", country: "New Zealand", basePrice: 1.0, rating: 87, role: "Right-arm Leg Spinner", stats: { matches: 8, wickets: 9, econ: 6.70, bbi: "3/14" } }
        ]
      },
      {
        category: "AR", code: "AR-04", title: "ALL-ROUNDERS",
        players: [
          { name: "Anukul Roy", country: "India", basePrice: 0.4, rating: 83, role: "Left-arm Spin All-Rounder", stats: { matches: 9, runs: 65, wickets: 5, sr: 125.0 } },
          { name: "Romario Shepherd", country: "West Indies", basePrice: 1.0, rating: 88, role: "Pace All-Rounder Finisher", stats: { matches: 10, runs: 115, wickets: 4, sr: 198.3 } },
          { name: "Rajvardhan Hangargekar", country: "India", basePrice: 0.4, rating: 83, role: "Fast Bowler & Power Hitter", stats: { matches: 2, runs: 10, wickets: 3, sr: 130.0 } },
          { name: "Jason Holder", country: "West Indies", basePrice: 1.5, rating: 89, role: "Pace All-Rounder", stats: { matches: 46, runs: 259, wickets: 53, sr: 122.7 } },
          { name: "Mahipal Lomror", country: "India", basePrice: 0.75, rating: 86, role: "Batting All-Rounder", stats: { matches: 40, runs: 527, wickets: 1, sr: 140.2 } },
          { name: "Azmatullah Omarzai", country: "Afghanistan", basePrice: 1.0, rating: 88, role: "Pace All-Rounder", stats: { matches: 7, runs: 42, wickets: 4, sr: 127.3 } }
        ]
      },
      {
        category: "WK", code: "WK-04", title: "WICKETKEEPERS",
        players: [
          { name: "Urvil Patel", country: "India", basePrice: 0.4, rating: 84, role: "Aggressive Wicketkeeper", stats: { matches: 3, runs: 45, dis: 2, sr: 160.0 } },
          { name: "Tim Seifert", country: "New Zealand", basePrice: 1.0, rating: 87, role: "Wicketkeeper Opener", stats: { matches: 3, runs: 26, dis: 3, sr: 108.3 } },
          { name: "Anuj Rawat", country: "India", basePrice: 0.5, rating: 85, role: "Wicketkeeper Batter", stats: { matches: 24, runs: 318, dis: 12, sr: 119.5 } },
          { name: "Alex Carey", country: "Australia", basePrice: 1.0, rating: 88, role: "Wicketkeeper Middle-order", stats: { matches: 3, runs: 32, dis: 4, sr: 110.3 } },
          { name: "Kumar Kushagra", country: "India", basePrice: 0.5, rating: 83, role: "Wicketkeeper Finisher", stats: { matches: 4, runs: 15, dis: 2, sr: 105.0 } },
          { name: "Josh Inglis", country: "Australia", basePrice: 1.5, rating: 91, role: "Wicketkeeper 360° Batter", stats: { matches: 6, runs: 140, dis: 5, sr: 155.6 } }
        ]
      }
    ]
  },
  // Round 05
  {
    round: 5,
    sets: [
      {
        category: "BAT", code: "BAT-05", title: "BATTERS",
        players: [
          { name: "Sarfaraz Khan", country: "India", basePrice: 0.75, rating: 86, role: "Middle-order Stroke Player", stats: { matches: 50, runs: 585, sr: 130.6, hs: "67" } },
          { name: "Tom Banton", country: "England", basePrice: 1.0, rating: 87, role: "Wicketkeeper / Aggressive Opener", stats: { matches: 2, runs: 18, sr: 90.0, hs: "10" } },
          { name: "Nitish Rana", country: "India", basePrice: 1.5, rating: 89, role: "Left-hand Middle-order Batter", stats: { matches: 107, runs: 2636, sr: 135.3, hs: "87" } },
          { name: "Glenn Phillips", country: "New Zealand", basePrice: 1.5, rating: 91, role: "Middle-order Power Hitter", stats: { matches: 8, runs: 65, sr: 138.3, hs: "25" } },
          { name: "Rahul Tripathi", country: "India", basePrice: 1.0, rating: 88, role: "Top-order Attacking Batter", stats: { matches: 95, runs: 2236, sr: 139.7, hs: "93" } },
          { name: "Matthew Breetzke", country: "South Africa", basePrice: 0.75, rating: 85, role: "Top-order Batter / Keeper", stats: { matches: 4, runs: 85, sr: 125.0, hs: "38" } }
        ]
      },
      {
        category: "FAST", code: "FAST-05", title: "FAST BOWLERS",
        players: [
          { name: "Akash Deep", country: "India", basePrice: 0.75, rating: 87, role: "Right-arm Fast Medium", stats: { matches: 8, wickets: 7, econ: 11.08, bbi: "3/45" } },
          { name: "Naveen-ul-Haq", country: "Afghanistan", basePrice: 1.5, rating: 90, role: "Right-arm Slower Ball Specialist", stats: { matches: 18, wickets: 25, econ: 8.80, bbi: "4/38" } },
          { name: "Shardul Thakur", country: "India", basePrice: 1.5, rating: 89, role: "Pace Bowling All-Rounder", stats: { matches: 95, wickets: 94, econ: 9.23, bbi: "4/36" } },
          { name: "Nathan Ellis", country: "Australia", basePrice: 1.0, rating: 89, role: "Death Overs Specialist", stats: { matches: 16, wickets: 18, econ: 8.64, bbi: "4/30" } },
          { name: "Umran Malik", country: "India", basePrice: 1.0, rating: 88, role: "Raw Pace Express (155 km/h)", stats: { matches: 26, wickets: 29, econ: 9.39, bbi: "5/25" } },
          { name: "Spencer Johnson", country: "Australia", basePrice: 1.0, rating: 87, role: "Left-arm Express Fast", stats: { matches: 5, wickets: 4, econ: 9.80, bbi: "2/25" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-05", title: "SPIN BOWLERS",
        players: [
          { name: "Karn Sharma", country: "India", basePrice: 0.5, rating: 84, role: "Right-arm Leg Spinner", stats: { matches: 84, wickets: 76, econ: 8.27, bbi: "4/16" } },
          { name: "Dunith Wellalage", country: "Sri Lanka", basePrice: 0.75, rating: 85, role: "Left-arm Orthodox", stats: { matches: 3, wickets: 4, econ: 7.50, bbi: "2/18" } },
          { name: "Jayant Yadav", country: "India", basePrice: 0.5, rating: 83, role: "Right-arm Off-break", stats: { matches: 20, wickets: 8, econ: 6.94, bbi: "1/18" } },
          { name: "Qais Ahmad", country: "Afghanistan", basePrice: 0.75, rating: 85, role: "Right-arm Leg Spinner", stats: { matches: 2, wickets: 2, econ: 8.00, bbi: "2/20" } },
          { name: "Vicky Ostwal", country: "India", basePrice: 0.3, rating: 81, role: "Left-arm Orthodox", stats: { matches: 1, wickets: 0, econ: 7.00, bbi: "0/15" } },
          { name: "Mohammad Nabi", country: "Afghanistan", basePrice: 1.0, rating: 88, role: "Off-spin All-Rounder", stats: { matches: 24, wickets: 15, econ: 7.20, bbi: "4/11" } }
        ]
      },
      {
        category: "AR", code: "AR-05", title: "ALL-ROUNDERS",
        players: [
          { name: "Sikandar Raza", country: "Zimbabwe", basePrice: 1.0, rating: 89, role: "Spin All-Rounder (Mystery)", stats: { matches: 9, runs: 182, wickets: 3, sr: 139.0 } },
          { name: "Daryl Mitchell", country: "New Zealand", basePrice: 1.5, rating: 91, role: "Middle-order Pace All-Rounder", stats: { matches: 15, runs: 351, wickets: 1, sr: 136.0 } },
          { name: "Kyle Mayers", country: "West Indies", basePrice: 1.0, rating: 88, role: "Opening Batter & Medium Pacer", stats: { matches: 13, runs: 379, wickets: 0, sr: 144.1 } },
          { name: "James Neesham", country: "New Zealand", basePrice: 1.0, rating: 87, role: "Pace All-Rounder", stats: { matches: 14, runs: 92, wickets: 8, sr: 143.8 } },
          { name: "Daniel Sams", country: "Australia", basePrice: 1.0, rating: 86, role: "Left-arm Fast All-Rounder", stats: { matches: 21, runs: 71, wickets: 14, sr: 135.0 } },
          { name: "George Linde", country: "South Africa", basePrice: 0.75, rating: 84, role: "Left-arm Spin All-Rounder", stats: { matches: 2, runs: 25, wickets: 2, sr: 120.0 } }
        ]
      },
      {
        category: "WK", code: "WK-05", title: "WICKETKEEPERS",
        players: [
          { name: "Vishnu Vinod", country: "India", basePrice: 0.4, rating: 83, role: "Wicketkeeper Attacking Batter", stats: { matches: 6, runs: 56, dis: 3, sr: 130.2 } },
          { name: "Jamie Smith", country: "England", basePrice: 1.0, rating: 88, role: "Wicketkeeper Dynamic Batter", stats: { matches: 4, runs: 110, dis: 4, sr: 152.0 } },
          { name: "Robin Minz", country: "India", basePrice: 0.4, rating: 82, role: "Wicketkeeper Power Hitter", stats: { matches: 2, runs: 20, dis: 1, sr: 140.0 } },
          { name: "Ben Duckett", country: "England", basePrice: 1.0, rating: 89, role: "Wicketkeeper Top-order Batter", stats: { matches: 5, runs: 125, dis: 3, sr: 145.0 } },
          { name: "Kartik Sharma", country: "India", basePrice: 0.3, rating: 81, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 10, dis: 1, sr: 110.0 } }
        ]
      }
    ]
  },
  // Round 06
  {
    round: 6,
    sets: [
      {
        category: "BAT", code: "BAT-06", title: "BATTERS",
        players: [
          { name: "Karun Nair", country: "India", basePrice: 0.5, rating: 85, role: "Top-order Classical Batter", stats: { matches: 76, runs: 1496, sr: 127.8, hs: "83*" } },
          { name: "Faf du Plessis", country: "South Africa", basePrice: 2.0, rating: 94, role: "Opening Legend & Leader", stats: { matches: 145, runs: 4571, sr: 136.4, hs: "96" } },
          { name: "Shashank Singh", country: "India", basePrice: 0.75, rating: 89, role: "Hard-hitting Finisher", stats: { matches: 24, runs: 423, sr: 161.4, hs: "68*" } },
          { name: "Rovman Powell", country: "West Indies", basePrice: 1.5, rating: 89, role: "Power Hitter", stats: { matches: 26, runs: 357, sr: 149.2, hs: "67*" } },
          { name: "Ashutosh Sharma", country: "India", basePrice: 0.5, rating: 88, role: "Impact Finisher", stats: { matches: 11, runs: 189, sr: 167.3, hs: "61" } },
          { name: "Tim David", country: "Australia", basePrice: 1.5, rating: 91, role: "Power Finisher", stats: { matches: 38, runs: 659, sr: 170.3, hs: "46" } }
        ]
      },
      {
        category: "FAST", code: "FAST-06", title: "FAST BOWLERS",
        players: [
          { name: "Mayank Yadav", country: "India", basePrice: 1.5, rating: 92, role: "Extreme Speed Fast Bowler (156.7 km/h)", stats: { matches: 4, wickets: 7, econ: 6.99, bbi: "3/14" } },
          { name: "Matt Henry", country: "New Zealand", basePrice: 1.0, rating: 89, role: "Right-arm Fast Medium", stats: { matches: 4, wickets: 4, econ: 9.25, bbi: "2/30" } },
          { name: "Harshit Rana", country: "India", basePrice: 1.5, rating: 90, role: "Right-arm Aggressive Fast", stats: { matches: 21, wickets: 25, econ: 8.95, bbi: "3/24" } },
          { name: "Jacob Duffy", country: "New Zealand", basePrice: 0.75, rating: 84, role: "Right-arm Swing Bowler", stats: { matches: 2, wickets: 3, econ: 8.50, bbi: "2/28" } },
          { name: "Yash Dayal", country: "India", basePrice: 1.0, rating: 88, role: "Left-arm Seam Bowler", stats: { matches: 28, wickets: 28, econ: 9.30, bbi: "3/20" } },
          { name: "Adam Milne", country: "New Zealand", basePrice: 1.0, rating: 87, role: "Right-arm Express Fast", stats: { matches: 10, wickets: 7, econ: 9.60, bbi: "2/21" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-06", title: "SPIN BOWLERS",
        players: [
          { name: "Prashant Solanki", country: "India", basePrice: 0.3, rating: 82, role: "Right-arm Leg Spinner", stats: { matches: 2, wickets: 2, econ: 6.33, bbi: "2/20" } },
          { name: "Himanshu Sharma", country: "India", basePrice: 0.3, rating: 81, role: "Right-arm Leg Spinner", stats: { matches: 2, wickets: 0, econ: 9.50, bbi: "0/28" } },
          { name: "Tanush Kotian", country: "India", basePrice: 0.4, rating: 83, role: "Right-arm Off-break", stats: { matches: 1, wickets: 0, econ: 7.75, bbi: "0/31" } },
          { name: "M Siddharth", country: "India", basePrice: 0.4, rating: 84, role: "Slow Left-arm Orthodox", stats: { matches: 3, wickets: 3, econ: 8.10, bbi: "1/21" } },
          { name: "Digvesh Singh Rathi", country: "India", basePrice: 0.3, rating: 80, role: "Right-arm Leg Spinner", stats: { matches: 1, wickets: 1, econ: 8.00, bbi: "1/25" } },
          { name: "Zeeshan Ansari", country: "India", basePrice: 0.3, rating: 80, role: "Right-arm Leg Spinner", stats: { matches: 1, wickets: 1, econ: 8.50, bbi: "1/27" } }
        ]
      },
      {
        category: "AR", code: "AR-06", title: "ALL-ROUNDERS",
        players: [
          { name: "Wiaan Mulder", country: "South Africa", basePrice: 0.75, rating: 85, role: "Pace All-Rounder", stats: { matches: 3, runs: 30, wickets: 2, sr: 115.0 } },
          { name: "Dasun Shanaka", country: "Sri Lanka", basePrice: 1.0, rating: 86, role: "Pace All-Rounder", stats: { matches: 3, runs: 26, wickets: 0, sr: 104.0 } },
          { name: "Kamindu Mendis", country: "Sri Lanka", basePrice: 1.0, rating: 88, role: "Ambidextrous Spinner & Batter", stats: { matches: 5, runs: 120, wickets: 3, sr: 130.0 } },
          { name: "Karim Janat", country: "Afghanistan", basePrice: 0.75, rating: 84, role: "Medium Fast All-Rounder", stats: { matches: 2, runs: 22, wickets: 1, sr: 122.0 } },
          { name: "Suryansh Shedge", country: "India", basePrice: 0.3, rating: 81, role: "Pace Bowling All-Rounder", stats: { matches: 1, runs: 15, wickets: 0, sr: 135.0 } },
          { name: "Musheer Khan", country: "India", basePrice: 0.5, rating: 85, role: "Left-arm Spin All-Rounder", stats: { matches: 2, runs: 45, wickets: 2, sr: 128.0 } }
        ]
      },
      {
        category: "WK", code: "WK-06", title: "WICKETKEEPERS",
        players: [
          { name: "Mukul Choudhary", country: "India", basePrice: 0.3, rating: 81, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 12, dis: 1, sr: 110.0 } },
          { name: "Vansh Bedi", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 8, dis: 1, sr: 100.0 } },
          { name: "Donovan Ferreira", country: "South Africa", basePrice: 0.75, rating: 86, role: "Wicketkeeper Power Finisher", stats: { matches: 2, runs: 8, dis: 2, sr: 133.3 } },
          { name: "Tushar Raheja", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Left-hand Batter", stats: { matches: 1, runs: 14, dis: 1, sr: 112.0 } },
          { name: "Lhuan-dre Pretorius", country: "South Africa", basePrice: 0.5, rating: 83, role: "Young Wicketkeeper Opener", stats: { matches: 2, runs: 35, dis: 2, sr: 135.0 } }
        ]
      }
    ]
  },
  // Round 07
  {
    round: 7,
    sets: [
      {
        category: "BAT", code: "BAT-07", title: "BATTERS",
        players: [
          { name: "Ayush Mhatre", country: "India", basePrice: 0.3, rating: 84, role: "Young Mumbai Opener", stats: { matches: 5, runs: 175, sr: 138.0, hs: "68" } },
          { name: "Abhinav Manohar", country: "India", basePrice: 0.75, rating: 86, role: "Middle-order Power Hitter", stats: { matches: 17, runs: 231, sr: 139.2, hs: "43" } },
          { name: "Vaibhav Sooryavanshi", country: "India", basePrice: 0.3, rating: 84, role: "Youngest Prodigy Opener (13y)", stats: { matches: 3, runs: 90, sr: 145.0, hs: "44" } },
          { name: "Angkrish Raghuvanshi", country: "India", basePrice: 0.75, rating: 87, role: "Top-order Stroke Player", stats: { matches: 10, runs: 163, sr: 155.2, hs: "54" } },
          { name: "Anmolpreet Singh", country: "India", basePrice: 0.5, rating: 83, role: "Top-order Batter", stats: { matches: 12, runs: 195, sr: 128.3, hs: "48" } },
          { name: "Atharva Taide", country: "India", basePrice: 0.5, rating: 84, role: "Opening Left-hand Batter", stats: { matches: 9, runs: 201, sr: 148.9, hs: "66" } }
        ]
      },
      {
        category: "FAST", code: "FAST-07", title: "FAST BOWLERS",
        players: [
          { name: "Sandeep Sharma", country: "India", basePrice: 1.5, rating: 91, role: "Swing & Death Knuckle-ball Master", stats: { matches: 127, wickets: 137, econ: 7.91, bbi: "5/18" } },
          { name: "Nandre Burger", country: "South Africa", basePrice: 1.0, rating: 89, role: "Left-arm Express Fast", stats: { matches: 6, wickets: 7, econ: 8.52, bbi: "2/29" } },
          { name: "Tushar Deshpande", country: "India", basePrice: 1.0, rating: 88, role: "Right-arm Strike Bowler", stats: { matches: 36, wickets: 42, econ: 9.48, bbi: "4/27" } },
          { name: "Lungi Ngidi", country: "South Africa", basePrice: 1.0, rating: 88, role: "Right-arm Fast Bowler", stats: { matches: 14, wickets: 25, econ: 8.30, bbi: "4/10" } },
          { name: "Anshul Kamboj", country: "India", basePrice: 0.4, rating: 85, role: "Right-arm Medium Fast Seamer", stats: { matches: 3, wickets: 2, econ: 8.90, bbi: "1/22" } },
          { name: "Dushmantha Chameera", country: "Sri Lanka", basePrice: 0.75, rating: 86, role: "Right-arm Express Fast", stats: { matches: 13, wickets: 10, econ: 8.89, bbi: "2/17" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-07", title: "SPIN BOWLERS",
        players: [
          { name: "Jagadeesha Suchith", country: "India", basePrice: 0.4, rating: 82, role: "Slow Left-arm Orthodox", stats: { matches: 22, wickets: 19, econ: 8.35, bbi: "2/25" } },
          { name: "Shams Mulani", country: "India", basePrice: 0.4, rating: 83, role: "Slow Left-arm Orthodox", stats: { matches: 3, wickets: 0, econ: 9.00, bbi: "0/18" } },
          { name: "Tanay Thyagarajan", country: "India", basePrice: 0.3, rating: 81, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 7.50, bbi: "1/23" } },
          { name: "Pradipta Pramanik", country: "India", basePrice: 0.3, rating: 80, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 7.80, bbi: "1/24" } },
          { name: "Mahesh Pithiya", country: "India", basePrice: 0.3, rating: 81, role: "Off-spin (Ashwin style)", stats: { matches: 1, wickets: 0, econ: 8.00, bbi: "0/22" } },
          { name: "Mayank Mishra", country: "India", basePrice: 0.3, rating: 80, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 7.20, bbi: "1/20" } }
        ]
      },
      {
        category: "AR", code: "AR-07", title: "ALL-ROUNDERS",
        players: [
          { name: "Nishant Sindhu", country: "India", basePrice: 0.4, rating: 83, role: "Left-arm Spin All-Rounder", stats: { matches: 2, runs: 28, wickets: 1, sr: 118.0 } },
          { name: "Prashant Veer", country: "India", basePrice: 0.3, rating: 81, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 16, wickets: 1, sr: 120.0 } },
          { name: "Aman Khan", country: "India", basePrice: 0.4, rating: 83, role: "Medium Pacer & Power Batter", stats: { matches: 12, runs: 115, wickets: 0, sr: 115.0 } },
          { name: "Raj Angad Bawa", country: "India", basePrice: 0.4, rating: 83, role: "Pace All-Rounder", stats: { matches: 2, runs: 11, wickets: 0, sr: 100.0 } },
          { name: "Atharva Ankolekar", country: "India", basePrice: 0.3, rating: 81, role: "Left-arm Spin All-Rounder", stats: { matches: 1, runs: 14, wickets: 1, sr: 110.0 } },
          { name: "Sairaj Patil", country: "India", basePrice: 0.3, rating: 80, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 12, wickets: 0, sr: 105.0 } }
        ]
      },
      {
        category: "WK", code: "WK-07", title: "WICKETKEEPERS",
        players: [
          { name: "Tejasvi Singh", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 10, dis: 1, sr: 105.0 } },
          { name: "Shai Hope", country: "West Indies", basePrice: 1.0, rating: 88, role: "Wicketkeeper Anchor Batter", stats: { matches: 9, runs: 183, dis: 6, sr: 150.0 } },
          { name: "Luvnith Sisodia", country: "India", basePrice: 0.3, rating: 81, role: "Wicketkeeper Opener", stats: { matches: 1, runs: 16, dis: 1, sr: 130.0 } },
          { name: "Narayan Jagadeesan", country: "India", basePrice: 0.5, rating: 85, role: "Wicketkeeper Top-order Batter", stats: { matches: 13, runs: 162, dis: 9, sr: 110.2 } },
          { name: "Bipin Saurav", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 15, dis: 1, sr: 115.0 } }
        ]
      }
    ]
  },
  // Round 08
  {
    round: 8,
    sets: [
      {
        category: "BAT", code: "BAT-08", title: "BATTERS",
        players: [
          { name: "Sameer Rizvi", country: "India", basePrice: 0.75, rating: 86, role: "Attacking Finisher", stats: { matches: 8, runs: 51, sr: 118.6, hs: "21" } },
          { name: "Nehal Wadhera", country: "India", basePrice: 0.75, rating: 88, role: "Left-hand Middle-order Batter", stats: { matches: 20, runs: 350, sr: 147.1, hs: "64" } },
          { name: "Rajat Patidar", country: "India", basePrice: 1.5, rating: 92, role: "Dominant Spin Basher", stats: { matches: 27, runs: 799, sr: 158.8, hs: "112*" } },
          { name: "Manish Pandey", country: "India", basePrice: 0.75, rating: 86, role: "Experienced Anchor Batter", stats: { matches: 171, runs: 3850, sr: 121.1, hs: "114*" } },
          { name: "Mayank Agarwal", country: "India", basePrice: 1.0, rating: 87, role: "Top-order Attacking Batter", stats: { matches: 127, runs: 2661, sr: 133.2, hs: "106" } },
          { name: "Yash Dhull", country: "India", basePrice: 0.4, rating: 83, role: "Top-order Stroke Maker", stats: { matches: 4, runs: 16, sr: 69.6, hs: "13" } }
        ]
      },
      {
        category: "FAST", code: "FAST-08", title: "FAST BOWLERS",
        players: [
          { name: "Vaibhav Arora", country: "India", basePrice: 0.75, rating: 87, role: "Right-arm Swing Bowler", stats: { matches: 18, wickets: 19, econ: 9.38, bbi: "3/27" } },
          { name: "Dilshan Madushanka", country: "Sri Lanka", basePrice: 1.0, rating: 88, role: "Left-arm Fast Seamer", stats: { matches: 4, wickets: 5, econ: 8.80, bbi: "2/24" } },
          { name: "Kartik Tyagi", country: "India", basePrice: 0.5, rating: 85, role: "Right-arm Fast Bowler", stats: { matches: 19, wickets: 15, econ: 10.01, bbi: "4/29" } },
          { name: "Blessing Muzarabani", country: "Zimbabwe", basePrice: 0.75, rating: 86, role: "Tall Bounce Fast Bowler", stats: { matches: 3, wickets: 4, econ: 7.90, bbi: "2/25" } },
          { name: "Shivam Mavi", country: "India", basePrice: 0.75, rating: 86, role: "Right-arm Fast Medium", stats: { matches: 32, wickets: 30, econ: 8.71, bbi: "4/21" } },
          { name: "Olly Stone", country: "England", basePrice: 0.75, rating: 85, role: "Right-arm Fast Bowler", stats: { matches: 2, wickets: 2, econ: 9.10, bbi: "1/28" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-08", title: "SPIN BOWLERS",
        players: [
          { name: "Yash Raj Punja", country: "India", basePrice: 0.3, rating: 80, role: "Right-arm Leg Spinner", stats: { matches: 1, wickets: 1, econ: 7.80, bbi: "1/22" } },
          { name: "Himanshu Singh", country: "India", basePrice: 0.3, rating: 81, role: "Tall Off Spinner", stats: { matches: 1, wickets: 1, econ: 7.60, bbi: "1/21" } },
          { name: "Shubham Agarwal", country: "India", basePrice: 0.3, rating: 80, role: "Right-arm Leg Spinner", stats: { matches: 1, wickets: 1, econ: 8.00, bbi: "1/25" } },
          { name: "Saurabh Kumar", country: "India", basePrice: 0.4, rating: 83, role: "Slow Left-arm Orthodox", stats: { matches: 2, wickets: 2, econ: 7.50, bbi: "2/22" } },
          { name: "Mayank Dagar", country: "India", basePrice: 0.4, rating: 83, role: "Slow Left-arm Orthodox", stats: { matches: 8, wickets: 2, econ: 10.13, bbi: "1/23" } },
          { name: "Aushik Srinivas", country: "India", basePrice: 0.3, rating: 80, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 7.70, bbi: "1/24" } }
        ]
      },
      {
        category: "AR", code: "AR-08", title: "ALL-ROUNDERS",
        players: [
          { name: "Sonu Yadav", country: "India", basePrice: 0.3, rating: 81, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 18, wickets: 1, sr: 125.0 } },
          { name: "Ravi Rajkumar", country: "India", basePrice: 0.3, rating: 80, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 12, wickets: 1, sr: 110.0 } },
          { name: "Mohamed Ali", country: "India", basePrice: 0.3, rating: 80, role: "Spin All-Rounder", stats: { matches: 1, runs: 14, wickets: 1, sr: 115.0 } },
          { name: "Sunny Sandhu", country: "India", basePrice: 0.3, rating: 80, role: "Pace All-Rounder", stats: { matches: 1, runs: 10, wickets: 1, sr: 105.0 } },
          { name: "Mayank Rawat", country: "India", basePrice: 0.3, rating: 81, role: "Off-spin All-Rounder", stats: { matches: 1, runs: 20, wickets: 0, sr: 130.0 } },
          { name: "Rahul Dagar", country: "India", basePrice: 0.3, rating: 80, role: "Spin All-Rounder", stats: { matches: 1, runs: 11, wickets: 0, sr: 105.0 } }
        ]
      },
      {
        category: "WK", code: "WK-08", title: "WICKETKEEPERS",
        players: [
          { name: "Hardik Tamore", country: "India", basePrice: 0.3, rating: 81, role: "Wicketkeeper Batter", stats: { matches: 2, runs: 24, dis: 2, sr: 114.0 } },
          { name: "Tejasvi Dahiya", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 12, dis: 1, sr: 110.0 } },
          { name: "Saurabh Nawale", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 8, dis: 1, sr: 95.0 } },
          { name: "Upendra Yadav", country: "India", basePrice: 0.4, rating: 82, role: "Wicketkeeper Batter", stats: { matches: 3, runs: 30, dis: 3, sr: 112.0 } },
          { name: "Rithik Easwaran", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 14, dis: 1, sr: 115.0 } },
          { name: "Shakir Habib Gandhi", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 9, dis: 1, sr: 100.0 } }
        ]
      }
    ]
  },
  // Round 09
  {
    round: 9,
    sets: [
      {
        category: "BAT", code: "BAT-09", title: "BATTERS",
        players: [
          { name: "Priyansh Arya", country: "India", basePrice: 0.4, rating: 87, role: "Explosive Left-hand Opener (6 sixes in over)", stats: { matches: 6, runs: 240, sr: 180.5, hs: "120" } },
          { name: "Abhimanyu Easwaran", country: "India", basePrice: 0.5, rating: 85, role: "Classical Top-order Anchor", stats: { matches: 30, runs: 750, sr: 122.0, hs: "70" } },
          { name: "Shahrukh Khan", country: "India", basePrice: 1.0, rating: 88, role: "Power Finisher", stats: { matches: 40, runs: 553, sr: 141.8, hs: "58" } },
          { name: "Harnoor Singh", country: "India", basePrice: 0.3, rating: 82, role: "U-19 World Cup Opener", stats: { matches: 2, runs: 30, sr: 115.0, hs: "25" } },
          { name: "Ricky Bhui", country: "India", basePrice: 0.4, rating: 83, role: "Top-order Batter", stats: { matches: 4, runs: 25, sr: 86.2, hs: "13" } }
        ]
      },
      {
        category: "FAST", code: "FAST-09", title: "FAST BOWLERS",
        players: [
          { name: "Umesh Yadav", country: "India", basePrice: 1.0, rating: 88, role: "Right-arm Fast Powerplay Bowler", stats: { matches: 148, wickets: 144, econ: 8.44, bbi: "4/23" } },
          { name: "Navdeep Saini", country: "India", basePrice: 0.75, rating: 86, role: "Right-arm Fast Bowler", stats: { matches: 34, wickets: 24, econ: 8.95, bbi: "3/36" } },
          { name: "Mohsin Khan", country: "India", basePrice: 1.0, rating: 89, role: "Left-arm Fast Seamer", stats: { matches: 24, wickets: 27, econ: 8.51, bbi: "4/16" } },
          { name: "Rasikh Dar", country: "India", basePrice: 0.5, rating: 86, role: "Right-arm Slower Ball Specialist", stats: { matches: 11, wickets: 10, econ: 10.45, bbi: "3/34" } },
          { name: "Vijaykumar Vyshak", country: "India", basePrice: 0.5, rating: 86, role: "Right-arm Medium Fast & Knuckle", stats: { matches: 11, wickets: 13, econ: 10.15, bbi: "3/23" } },
          { name: "Sakib Hussain", country: "India", basePrice: 0.3, rating: 81, role: "Right-arm Fast Medium", stats: { matches: 1, wickets: 1, econ: 9.00, bbi: "1/28" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-09", title: "SPIN BOWLERS",
        players: [
          { name: "Parth Bhut", country: "India", basePrice: 0.3, rating: 81, role: "Slow Left-arm Orthodox", stats: { matches: 1, wickets: 1, econ: 7.50, bbi: "1/22" } },
          { name: "Ankit Sharma", country: "India", basePrice: 0.3, rating: 81, role: "Slow Left-arm Orthodox", stats: { matches: 21, wickets: 12, econ: 7.70, bbi: "2/17" } },
          { name: "Swapnil Singh", country: "India", basePrice: 0.5, rating: 85, role: "Left-arm Orthodox All-Rounder", stats: { matches: 14, wickets: 7, econ: 8.85, bbi: "2/28" } },
          { name: "Shahbaz Ahmed", country: "India", basePrice: 1.0, rating: 88, role: "Left-arm Spin All-Rounder", stats: { matches: 55, wickets: 17, econ: 8.92, bbi: "3/7" } },
          { name: "Harpreet Brar", country: "India", basePrice: 1.0, rating: 88, role: "Slow Left-arm Tight Bowler", stats: { matches: 41, wickets: 25, econ: 7.91, bbi: "3/15" } },
          { name: "Rahul Tewatia", country: "India", basePrice: 1.5, rating: 91, role: "Leg Spinner & Iceman Finisher", stats: { matches: 93, runs: 1013, wickets: 32, sr: 138.8 } }
        ]
      },
      {
        category: "AR", code: "AR-09", title: "ALL-ROUNDERS",
        players: [
          { name: "Harsh Tyagi", country: "India", basePrice: 0.3, rating: 81, role: "Left-arm Spin All-Rounder", stats: { matches: 1, runs: 10, wickets: 1, sr: 110.0 } },
          { name: "Vipraj Nigam", country: "India", basePrice: 0.3, rating: 81, role: "Spin All-Rounder", stats: { matches: 1, runs: 12, wickets: 1, sr: 115.0 } },
          { name: "Macneil Noronha", country: "India", basePrice: 0.3, rating: 80, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 15, wickets: 0, sr: 112.0 } },
          { name: "Abdul Samad", country: "India", basePrice: 0.75, rating: 87, role: "Power Finisher & Leg Spinner", stats: { matches: 50, runs: 577, wickets: 2, sr: 146.1 } },
          { name: "Shivam Singh", country: "India", basePrice: 0.3, rating: 82, role: "Batting All-Rounder", stats: { matches: 2, runs: 30, wickets: 1, sr: 125.0 } },
          { name: "Rishi Dhawan", country: "India", basePrice: 0.5, rating: 84, role: "Medium Fast All-Rounder", stats: { matches: 38, runs: 210, wickets: 25, sr: 112.9 } }
        ]
      },
      {
        category: "WK", code: "WK-09", title: "WICKETKEEPERS",
        players: [
          { name: "Amith Sathvik", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 15, dis: 1, sr: 115.0 } },
          { name: "Suraj Ahuja", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 10, dis: 1, sr: 100.0 } },
          { name: "Ravi Singh", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 11, dis: 1, sr: 105.0 } },
          { name: "Akash Anand", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 14, dis: 1, sr: 110.0 } },
          { name: "Mandar Bhandari", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 8, dis: 1, sr: 95.0 } },
          { name: "Pranav Rajvanshi", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 12, dis: 1, sr: 108.0 } }
        ]
      }
    ]
  },
  // Round 10
  {
    round: 10,
    sets: [
      {
        category: "BAT", code: "BAT-10", title: "BATTERS",
        players: [
          { name: "Ankit Kumar", country: "India", basePrice: 0.3, rating: 82, role: "Opening Batter", stats: { matches: 2, runs: 35, sr: 122.0, hs: "28" } },
          { name: "Pradosh Ranjan Paul", country: "India", basePrice: 0.4, rating: 83, role: "Left-hand Middle-order", stats: { matches: 2, runs: 40, sr: 128.0, hs: "31" } },
          { name: "Swastik Chikara", country: "India", basePrice: 0.4, rating: 84, role: "Attacking Opener", stats: { matches: 2, runs: 50, sr: 150.0, hs: "38" } },
          { name: "Ashwin Hebbar", country: "India", basePrice: 0.3, rating: 81, role: "Top-order Batter", stats: { matches: 1, runs: 18, sr: 115.0, hs: "18" } }
        ]
      },
      {
        category: "FAST", code: "FAST-10", title: "FAST BOWLERS",
        players: [
          { name: "Auqib Nabi", country: "India", basePrice: 0.4, rating: 83, role: "Right-arm Medium Fast", stats: { matches: 2, wickets: 2, econ: 8.60, bbi: "2/26" } },
          { name: "Gurjapneet Singh", country: "India", basePrice: 0.4, rating: 84, role: "Tall Left-arm Fast Bowler", stats: { matches: 2, wickets: 3, econ: 8.20, bbi: "2/22" } },
          { name: "Simarjeet Singh", country: "India", basePrice: 0.5, rating: 86, role: "Right-arm Hit-the-deck Fast", stats: { matches: 10, wickets: 9, econ: 8.90, bbi: "3/26" } },
          { name: "Prince Yadav", country: "India", basePrice: 0.3, rating: 80, role: "Right-arm Fast Medium", stats: { matches: 1, wickets: 1, econ: 9.00, bbi: "1/26" } },
          { name: "Money Grewal", country: "India", basePrice: 0.3, rating: 81, role: "Right-arm Fast Bowler", stats: { matches: 1, wickets: 1, econ: 8.80, bbi: "1/24" } },
          { name: "Akash Madhwal", country: "India", basePrice: 0.75, rating: 87, role: "Right-arm Searing Yorker Specialist", stats: { matches: 13, wickets: 19, econ: 9.38, bbi: "5/5" } }
        ]
      },
      {
        category: "SPIN", code: "SPIN-10", title: "SPIN BOWLERS",
        players: [
          { name: "Axar Patel", country: "India", basePrice: 2.0, rating: 95, role: "Left-arm Orthodox All-Rounder", stats: { matches: 150, runs: 1653, wickets: 123, econ: 7.24 } },
          { name: "Ravindra Jadeja", country: "India", basePrice: 2.0, rating: 96, role: "Sir Jadeja — Elite All-Rounder", stats: { matches: 240, runs: 2959, wickets: 160, econ: 7.60 } },
          { name: "Washington Sundar", country: "India", basePrice: 1.5, rating: 89, role: "Powerplay Off-spinner & Batter", stats: { matches: 60, runs: 378, wickets: 37, econ: 7.54 } },
          { name: "Mitchell Santner", country: "New Zealand", basePrice: 1.0, rating: 89, role: "Left-arm Orthodox Control Bowler", stats: { matches: 18, wickets: 15, econ: 6.92, bbi: "2/13" } }
        ]
      },
      {
        category: "AR", code: "AR-10", title: "ALL-ROUNDERS",
        players: [
          { name: "Vicky Singh", country: "India", basePrice: 0.3, rating: 80, role: "Medium Pace All-Rounder", stats: { matches: 1, runs: 15, wickets: 0, sr: 115.0 } },
          { name: "Arshin Kulkarni", country: "India", basePrice: 0.5, rating: 84, role: "Pace All-Rounder & Opener", stats: { matches: 2, runs: 9, wickets: 0, sr: 90.0 } },
          { name: "Raj Limbani", country: "India", basePrice: 0.4, rating: 83, role: "U-19 Swing Fast Bowler", stats: { matches: 2, runs: 12, wickets: 2, sr: 110.0 } },
          { name: "Naman Dhir", country: "India", basePrice: 0.75, rating: 87, role: "Hard-hitting All-Rounder & Off-spin", stats: { matches: 7, runs: 140, wickets: 0, sr: 166.7 } }
        ]
      },
      {
        category: "WK", code: "WK-10", title: "WICKETKEEPERS",
        players: [
          { name: "Saurabh Rawat", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 14, dis: 1, sr: 105.0 } },
          { name: "Rahul Radesh", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 12, dis: 1, sr: 100.0 } },
          { name: "Pragnay Reddy", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 15, dis: 1, sr: 110.0 } },
          { name: "Ali Kachi", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 10, dis: 1, sr: 95.0 } },
          { name: "Hrituraj Roy", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 11, dis: 1, sr: 100.0 } },
          { name: "Kanhaiya Wadhawan", country: "India", basePrice: 0.3, rating: 80, role: "Wicketkeeper Batter", stats: { matches: 1, runs: 16, dis: 1, sr: 115.0 } }
        ]
      }
    ]
  }
];

// Deduplication & 5-Category 8-Player Set Partitioning:
// 1. BAT – Specialist Batters
// 2. BOWL – Specialist Fast Bowlers
// 3. AR – All-rounders
// 4. SP – Specialist Spinners
// 5. WK – Wicketkeepers

const countryFlags = {
  "India": { flag: "🇮🇳", code: "IND" },
  "Australia": { flag: "🇦🇺", code: "AUS" },
  "England": { flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", code: "ENG" },
  "South Africa": { flag: "🇿🇦", code: "SA" },
  "West Indies": { flag: "🌴", code: "WI" },
  "New Zealand": { flag: "🇳🇿", code: "NZ" },
  "Afghanistan": { flag: "🇦🇫", code: "AFG" },
  "Sri Lanka": { flag: "🇱🇰", code: "SL" },
  "Zimbabwe": { flag: "🇿🇼", code: "ZIM" },
  "Bangladesh": { flag: "🇧🇩", code: "BAN" }
};

const categoryDefinitions = [
  { key: "BAT", rawKey: "BAT", title: "Specialist Batters", setPrefix: "Batter Set" },
  { key: "BOWL", rawKey: "FAST", title: "Specialist Fast Bowlers", setPrefix: "Bowler Set" },
  { key: "AR", rawKey: "AR", title: "All-rounders", setPrefix: "All-rounder Set" },
  { key: "SP", rawKey: "SPIN", title: "Specialist Spinners", setPrefix: "Spinner Set" },
  { key: "WK", rawKey: "WK", title: "Wicketkeepers", setPrefix: "Wicketkeeper Set" }
];

// Extract players in their original relative sequence per category
const categorizedPlayers = {
  BAT: [],
  BOWL: [],
  AR: [],
  SP: [],
  WK: []
};

const seenNames = new Map();

for (const roundData of rawRounds) {
  for (const set of roundData.sets) {
    const matchedDef = categoryDefinitions.find(c => c.rawKey === set.category);
    if (!matchedDef) continue;

    for (const p of set.players) {
      const normalizedName = p.name.trim().toLowerCase();
      if (seenNames.has(normalizedName)) {
        console.log(`Deduplicating duplicate entry: "${p.name}" in Round ${roundData.round} ${set.code}`);
        continue;
      }

      seenNames.set(normalizedName, true);
      categorizedPlayers[matchedDef.key].push({
        ...p,
        originalRound: roundData.round,
        category: matchedDef.key,
        categoryTitle: matchedDef.title
      });
    }
  }
}

// 1. Chunk each category into sets of up to 8 players
const SET_SIZE = 8;
const categorySets = {};
let maxRounds = 0;

for (const catDef of categoryDefinitions) {
  const catList = categorizedPlayers[catDef.key];
  const totalInCat = catList.length;
  const numSets = Math.ceil(totalInCat / SET_SIZE);
  if (numSets > maxRounds) maxRounds = numSets;

  categorySets[catDef.key] = [];
  for (let s = 0; s < numSets; s++) {
    const chunk = catList.slice(s * SET_SIZE, (s + 1) * SET_SIZE);
    categorySets[catDef.key].push({
      setNumber: s + 1,
      setName: `${catDef.setPrefix} ${s + 1}`,
      players: chunk
    });
  }
  console.log(`Category ${catDef.key} (${catDef.title}): ${totalInCat} players across ${numSets} sets`);
}

// 2. Assemble catalog in Round-Robin order:
// ROUND 1: BAT Set 1 -> BOWL Set 1 -> AR Set 1 -> SP Set 1 -> WK Set 1
// ROUND 2: BAT Set 2 -> BOWL Set 2 -> AR Set 2 -> SP Set 2 -> WK Set 2
// ...
const finalCatalog = [];
let overallLotCounter = 1;

for (let r = 0; r < maxRounds; r++) {
  const roundNumber = r + 1;
  console.log(`\n--- ROUND ${roundNumber} ---`);

  for (const catDef of categoryDefinitions) {
    const setObj = categorySets[catDef.key][r];
    if (!setObj) {
      console.log(`Category ${catDef.key} has no more sets in Round ${roundNumber}, skipping.`);
      continue;
    }

    console.log(`  ${catDef.key}: ${setObj.setName} (${setObj.players.length} players)`);

    setObj.players.forEach((p, index) => {
      const lotInSet = index + 1;
      const setTotal = setObj.players.length;
      const isOverseas = p.country !== "India";
      const initials = p.name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
      const encodedName = encodeURIComponent(p.name + " cricketer");
      const imageUrl = `https://tse1.mm.bing.net/th?q=${encodedName}%20portrait%20hd&w=800&h=800&c=7&rs=1&p=0`;
      const cData = countryFlags[p.country] || { flag: "🏏", code: p.country.substring(0, 3).toUpperCase() };

      const playerRecord = {
        id: `PL_${String(overallLotCounter).padStart(3, '0')}`,
        name: p.name,
        category: catDef.key,
        categoryTitle: catDef.title,
        setName: setObj.setName,
        setNumber: setObj.setNumber,
        lotInSet: lotInSet,
        setTotal: setTotal,
        overallLot: overallLotCounter,
        round: roundNumber,
        categorySet: `${catDef.key}-SET-${String(setObj.setNumber).padStart(2, '0')}`,
        country: p.country,
        countryFlag: cData.flag,
        countryCode: cData.code,
        isOverseas,
        initials,
        role: p.role,
        basePrice: p.basePrice,
        rating: p.rating,
        stats: p.stats || {},
        imageUrl,
        status: "available",
        soldTo: null,
        soldPrice: null
      };

      overallLotCounter++;
      finalCatalog.push(playerRecord);
    });
  }
}

console.log(`\nTotal final players cataloged in round-robin sequence: ${finalCatalog.length}`);

// Ensure data folder exists
const outDir = path.join(__dirname);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

fs.writeFileSync(path.join(outDir, 'players.json'), JSON.stringify(finalCatalog, null, 2));
console.log(`Wrote ${finalCatalog.length} players to players.json successfully.`);


