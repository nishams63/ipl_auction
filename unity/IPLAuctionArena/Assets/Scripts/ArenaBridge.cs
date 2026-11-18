using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace IplArena
{
    // Receives state from React via unityInstance.SendMessage("ArenaBridge", "ApplyState", json).
    // Display only: this class never sends bids or any auction action anywhere.
    public class ArenaBridge : MonoBehaviour
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void ArenaNotifyReady();
        [DllImport("__Internal")] private static extern void ArenaNotifyError(string message);
#else
        private static void ArenaNotifyReady() { }
        private static void ArenaNotifyError(string message) { Debug.LogWarning(message); }
#endif

        public ArenaPresenter presenter;
        public ArenaQuality quality;
        public int statesApplied;
        public int statesRejected;

        private void Start()
        {
            ArenaNotifyReady();
        }

        // Called from JavaScript with a JSON snapshot
        public void ApplyState(string json)
        {
            ArenaState state;
            try
            {
                if (string.IsNullOrEmpty(json) || json.Length > 200000) throw new ArgumentException("state too large or empty");
                state = JsonUtility.FromJson<ArenaState>(json);
                if (state == null || state.v != 1) throw new ArgumentException("unsupported state version");
            }
            catch (Exception e)
            {
                statesRejected++;
                ArenaNotifyError("Arena state rejected: " + e.Message);
                return;
            }
            statesApplied++;
            if (presenter != null) presenter.Apply(state);
        }

        // "auto" | "low" | "high"
        public void SetQuality(string level)
        {
            if (quality != null) quality.SetLevel(level);
        }
    }
}
