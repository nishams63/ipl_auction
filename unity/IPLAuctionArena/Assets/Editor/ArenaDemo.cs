using UnityEditor;
using UnityEngine;

namespace IplArena.Editor
{
    // Play-mode preview: feeds sample snapshots to ArenaBridge exactly as React would, so the
    // visuals can be checked without the website. Sample data only; nothing is sent anywhere.
    public static class ArenaDemo
    {
        private static int version = 1;
        private static float bid = 2f;
        private static string bidder = "";
        private static string hammer = "OPEN";
        private static string status = "active";
        private static int lot = 1;
        private static int countdown = 15;

        private static readonly string[,] Teams =
        {
            { "CSK", "#FACC15", "#1E3A8A" }, { "MI", "#004BA0", "#D1AB3E" }, { "RCB", "#DC2626", "#111827" },
            { "KKR", "#3B0764", "#EAB308" }, { "SRH", "#F97316", "#111827" }, { "RR", "#EC4899", "#1E3A8A" },
            { "DC", "#1D4ED8", "#DC2626" }, { "PBKS", "#E11D48", "#D1D5DB" }, { "GT", "#0F172A", "#CA8A04" }, { "LSG", "#0EA5E9", "#F97316" }
        };

        private static void Send()
        {
            var bridge = Object.FindFirstObjectByType<ArenaBridge>();
            if (!EditorApplication.isPlaying || bridge == null) { Debug.LogWarning("Enter Play mode in the Arena scene first."); return; }
            var f = new System.Text.StringBuilder();
            for (int i = 0; i < Teams.GetLength(0); i++)
            {
                if (i > 0) f.Append(',');
                bool spent = hammer == "SOLD" && Teams[i, 0] == bidder;
                f.AppendFormat("{{\"id\":\"{0}\",\"code\":\"{0}\",\"name\":\"{0}\",\"color\":\"{1}\",\"color2\":\"{2}\",\"purse\":{3},\"squad\":{4},\"claimed\":{5}}}",
                    Teams[i, 0], Teams[i, 1], Teams[i, 2], spent ? (120f - bid).ToString(System.Globalization.CultureInfo.InvariantCulture) : "120", spent ? 1 : 0, i < 6 ? "true" : "false");
            }
            string json = "{\"v\":1,\"status\":\"" + status + "\",\"hasLot\":true,\"lot\":{\"number\":" + lot + ",\"total\":250,\"playerId\":\"DEMO_" + lot +
                "\",\"name\":\"Demo Player " + lot + "\",\"role\":\"Top-order Batter\",\"category\":\"BAT\",\"country\":\"India\",\"overseas\":false,\"basePrice\":2,\"highestBid\":" +
                bid.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"bidder\":\"" + bidder + "\",\"bidCount\":0,\"version\":" + version + ",\"countdown\":" + countdown +
                ",\"timerDuration\":15,\"hammer\":\"" + hammer + "\"},\"franchises\":[" + f + "]}";
            bridge.ApplyState(json);
        }

        [MenuItem("IPL Arena/Preview (Play mode)/New player")] public static void NewPlayer() { lot++; version = 1; bid = 2f; bidder = ""; hammer = "OPEN"; status = "active"; countdown = 15; Send(); }
        [MenuItem("IPL Arena/Preview (Play mode)/Bid: MI")] public static void BidMI() { Bid("MI"); }
        [MenuItem("IPL Arena/Preview (Play mode)/Bid: CSK")] public static void BidCSK() { Bid("CSK"); }
        [MenuItem("IPL Arena/Preview (Play mode)/Timer: 4 s left")] public static void Low() { countdown = 4; Send(); }
        [MenuItem("IPL Arena/Preview (Play mode)/SOLD")] public static void Sold() { hammer = string.IsNullOrEmpty(bidder) ? "UNSOLD" : "SOLD"; countdown = 0; Send(); }
        [MenuItem("IPL Arena/Preview (Play mode)/UNSOLD")] public static void Unsold() { bidder = ""; bid = 0; hammer = "UNSOLD"; countdown = 0; Send(); }
        [MenuItem("IPL Arena/Preview (Play mode)/Pause or resume")] public static void Pause() { status = status == "paused" ? "active" : "paused"; Send(); }
        [MenuItem("IPL Arena/Preview (Play mode)/Auction complete")] public static void Complete() { status = "completed"; Send(); }

        private static void Bid(string id)
        {
            if (hammer != "OPEN") NewPlayer();
            bid = string.IsNullOrEmpty(bidder) ? 2f : bid + 0.2f;
            bidder = id; version++; countdown = 15; Send();
        }
    }
}
