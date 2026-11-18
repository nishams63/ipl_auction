using System;

namespace IplArena
{
    // Snapshot of the PUBLIC auction state, sent by the React app (see client/src/utils/arenaState.js).
    // Unity only displays it. Nothing here can be sent back to the auction server.
    [Serializable]
    public class ArenaState
    {
        public int v;
        public string status = "";      // lobby | active | paused | completed
        public bool hasLot;
        public ArenaLot lot = new ArenaLot();
        public ArenaFranchise[] franchises = new ArenaFranchise[0];
    }

    [Serializable]
    public class ArenaLot
    {
        public int number;
        public int total;
        public string playerId = "";
        public string name = "";
        public string role = "";
        public string category = "";
        public string country = "";
        public bool overseas;
        public float basePrice;
        public float highestBid;
        public string bidder = "";      // franchise id of the highest bidder ("" = none)
        public int bidCount;
        public int version;
        public int countdown;
        public int timerDuration;
        public string hammer = "";      // OPEN | GOING | SOLD | UNSOLD | SKIPPED
    }

    [Serializable]
    public class ArenaFranchise
    {
        public string id = "";
        public string code = "";
        public string name = "";
        public string color = "#64748B";
        public string color2 = "#1E293B";
        public float purse;
        public int squad;
        public bool claimed;
    }
}
