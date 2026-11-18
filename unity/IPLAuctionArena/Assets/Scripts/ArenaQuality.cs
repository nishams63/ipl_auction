using UnityEngine;

namespace IplArena
{
    // Quality tiers for WebGL. "auto" starts high and drops to low if the frame rate stays poor.
    public class ArenaQuality : MonoBehaviour
    {
        public Light keyLight;
        public Light[] lights;
        public ParticleSystem confetti;
        public ArenaCameraRig cameraRig;
        public bool High { get; private set; } = true;
        public string Level { get; private set; } = "auto";

        private float avgDelta = 1f / 60f;
        private float lowFor;

        private void Start() { Apply(true); }

        public void SetLevel(string level)
        {
            Level = level == "low" || level == "high" ? level : "auto";
            Apply(Level != "low");
        }

        private void Apply(bool high)
        {
            High = high;
            Application.targetFrameRate = high ? 60 : 30;
            QualitySettings.shadowDistance = high ? 45f : 0f;
            QualitySettings.antiAliasing = high ? 2 : 0;
            if (keyLight != null)
            {
                keyLight.shadows = high ? LightShadows.Soft : LightShadows.None;
                keyLight.shadowStrength = 0.6f;
            }
            if (lights != null)
                for (int i = 1; i < lights.Length; i++) if (lights[i] != null && lights[i].type == LightType.Spot) lights[i].enabled = high;
            // Camera moves cost no GPU time, so Low keeps them (booth cuts stay High-only in the presenter)
        }

        private void Update()
        {
            if (Level != "auto" || !High) return;
            float dt = Time.unscaledDeltaTime;
            // A single long frame is a stall (hidden tab, modal dialog, loading), not a slow GPU
            if (dt > 0.25f) { lowFor = 0f; return; }
            avgDelta = Mathf.Lerp(avgDelta, dt, 0.05f);
            lowFor = 1f / avgDelta < 28f ? lowFor + dt : 0f;
            if (lowFor > 4f) Apply(false); // sustained < 28 fps: fall back for weaker GPUs
        }
    }
}
