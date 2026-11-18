using System.Collections;
using UnityEngine;

namespace IplArena
{
    // Turns auction snapshots into visuals. It reacts to CHANGES between snapshots (new player,
    // new bid, hammer result, pause, completion) and otherwise just displays the latest values.
    // It never decides anything: SOLD/UNSOLD, bids, timer and order all come from the server
    // through React.
    public class ArenaPresenter : MonoBehaviour
    {
        public ScreenRefs screen;
        public FranchiseBooth[] booths;
        public Transform gavel;
        public ArenaCameraRig cameraRig;
        public ParticleSystem confetti;
        public ArenaQuality quality;
        public Light[] lights;
        public ArenaBuilder builder;

        private ArenaState last;
        private float[] baseIntensity;
        private Coroutine bannerRoutine;
        private Coroutine gavelRoutine;
        private float bidPunch;
        private bool warning;

        private static readonly Color Gold = new Color(1f, 0.76f, 0.25f);

        private void Start()
        {
            baseIntensity = new float[lights.Length];
            for (int i = 0; i < lights.Length; i++) baseIntensity[i] = lights[i] != null ? lights[i].intensity : 0f;
        }

        public void Apply(ArenaState s)
        {
            bool first = last == null;
            ApplyFranchises(s);
            ApplyScreen(s);

            if (!first)
            {
                var a = last.lot; var b = s.lot;
                bool newPlayer = s.hasLot && (!last.hasLot || a.playerId != b.playerId || a.number != b.number);
                if (newPlayer) PresentNewPlayer();
                else if (s.hasLot && b.version > a.version && !string.IsNullOrEmpty(b.bidder)) BidUpdate(s);
                if (s.hasLot && b.hammer != a.hammer)
                {
                    if (b.hammer == "SOLD") SoldEffect(s, true);
                    else if (b.hammer == "UNSOLD") UnsoldEffect(true);
                }
                if (s.status != last.status)
                {
                    if (s.status == "paused") PauseEffect(true);
                    else if (last.status == "paused") PauseEffect(false);
                    if (s.status == "completed") CompleteEffect(true);
                }
            }
            else
            {
                // First snapshot (page load / reconnect): show the current situation without replaying celebrations
                if (s.status == "completed") CompleteEffect(false);
                else if (s.hasLot && s.lot.hammer == "SOLD") SoldEffect(s, false);
                else if (s.hasLot && s.lot.hammer == "UNSOLD") UnsoldEffect(false);
                if (s.status == "paused") PauseEffect(true);
            }
            last = s;
        }

        private int BoothIndex(string id)
        {
            for (int i = 0; i < booths.Length; i++) if (booths[i].code == id) return i;
            return -1;
        }

        private void ApplyFranchises(ArenaState s)
        {
            if (s.franchises == null) return;
            foreach (var f in s.franchises)
            {
                int i = BoothIndex(f.id);
                if (i < 0) continue;
                var main = ArenaBuilder.Hex(f.color, Color.gray);
                var second = ArenaBuilder.Hex(f.color2, main * 0.5f);
                booths[i].ApplyColors(main, second);
                booths[i].SetInfo(string.IsNullOrEmpty(f.code) ? f.id : f.code, f.purse, f.squad, f.claimed);
                booths[i].SetLeader(s.hasLot && s.lot.bidder == f.id && s.lot.hammer != "UNSOLD");
            }
        }

        private static string Money(float cr) { return string.Format("Rs {0:0.00} Cr", cr); }

        private string CodeOf(ArenaState s, string id)
        {
            if (s.franchises != null) foreach (var f in s.franchises) if (f.id == id) return string.IsNullOrEmpty(f.code) ? f.id : f.code;
            return id;
        }

        private Color ColorOf(ArenaState s, string id)
        {
            if (s.franchises != null) foreach (var f in s.franchises) if (f.id == id) return Readable(ArenaBuilder.Hex(f.color, Gold));
            return Gold;
        }

        // Franchise colours are shown on a dark-blue screen: lift dark ones (e.g. navy) so text stays legible
        private static Color Readable(Color c)
        {
            float lum = 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b;
            return lum < 0.45f ? Color.Lerp(c, Color.white, Mathf.Clamp01((0.45f - lum) / 0.45f) * 0.75f + 0.15f) : c;
        }

        private void ApplyScreen(ArenaState s)
        {
            var l = s.lot;
            if (!s.hasLot)
            {
                screen.lotLine.text = s.status == "completed" ? "IPL AUCTION" : "IPL AUCTION - STAND BY";
                screen.name.text = s.status == "completed" ? "" : "WAITING FOR THE NEXT LOT";
                screen.role.text = screen.basePrice.text = screen.bid.text = screen.bidder.text = screen.timer.text = "";
                screen.bidCaption.text = "";
                SetSegments(0, 1, false);
                return;
            }
            screen.lotLine.text = string.Format("LOT {0} OF {1}", l.number, l.total);
            screen.name.text = Fit(l.name.ToUpperInvariant(), 26);
            screen.role.text = Fit(l.role, 44) + (l.overseas ? "  |  OVERSEAS" : "  |  INDIA");
            screen.basePrice.text = "BASE PRICE  " + Money(l.basePrice);
            screen.bidCaption.text = string.IsNullOrEmpty(l.bidder) ? "OPENING BID" : "CURRENT BID";
            screen.bid.text = string.IsNullOrEmpty(l.bidder) ? Money(l.basePrice) : Money(l.highestBid);
            screen.bidder.text = string.IsNullOrEmpty(l.bidder) ? "NO BIDS YET" : CodeOf(s, l.bidder) + " LEADS";
            screen.bidder.color = string.IsNullOrEmpty(l.bidder) ? new Color(0.75f, 0.8f, 0.9f) : ColorOf(s, l.bidder);
            bool open = l.hammer != "SOLD" && l.hammer != "UNSOLD" && l.hammer != "SKIPPED";
            screen.timer.text = open && s.status == "active" ? l.countdown.ToString() : "";
            warning = open && s.status == "active" && l.countdown <= 5 && l.countdown > 0;
            SetSegments(l.countdown, Mathf.Max(1, l.timerDuration), open);
        }

        private static string Fit(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max - 1) + ".";
        }

        private void SetSegments(int countdown, int duration, bool open)
        {
            int lit = open ? Mathf.Clamp(Mathf.CeilToInt(countdown / (float)duration * screen.segments.Length), 0, screen.segments.Length) : 0;
            for (int i = 0; i < screen.segments.Length; i++) screen.segments[i].enabled = i < lit;
            float frac = countdown / (float)duration;
            var c = frac > 0.5f ? new Color(0.2f, 0.9f, 0.5f) : frac > 0.25f ? new Color(1f, 0.75f, 0.2f) : new Color(1f, 0.25f, 0.2f);
            screen.segmentMaterial.SetColor("_EmissionColor", c * 2.2f);
            screen.segmentMaterial.color = c * 0.4f;
            screen.timer.color = c;
        }

        // ── reactions ──────────────────────────────────────────────────────
        private void PresentNewPlayer()
        {
            HideBanner();
            if (cameraRig != null) cameraRig.ShotStage(3.2f);
            bidPunch = 0.6f;
        }

        private void BidUpdate(ArenaState s)
        {
            bidPunch = 1f;
            int i = BoothIndex(s.lot.bidder);
            if (i >= 0)
            {
                booths[i].Flash();
                if (cameraRig != null && quality != null && quality.High) cameraRig.ShotBooth(i, 1.6f);
            }
        }

        private void SoldEffect(ArenaState s, bool animate)
        {
            var color = ColorOf(s, s.lot.bidder);
            ShowBanner("SOLD", string.IsNullOrEmpty(s.lot.bidder) ? "" : "TO " + CodeOf(s, s.lot.bidder) + "  FOR  " + Money(s.lot.highestBid), color, animate);
            if (!animate) return;
            if (gavelRoutine != null) StopCoroutine(gavelRoutine);
            gavelRoutine = StartCoroutine(GavelStrike(3));
            if (cameraRig != null) cameraRig.ShotScreen(2.6f);
            if (confetti != null && quality != null && quality.High)
            {
                var main = confetti.main;
                main.startColor = new ParticleSystem.MinMaxGradient(color, Color.white);
                confetti.Emit(220);
            }
        }

        private void UnsoldEffect(bool animate)
        {
            ShowBanner("UNSOLD", "NO BIDS", new Color(0.7f, 0.72f, 0.78f), animate);
            if (animate) { if (gavelRoutine != null) StopCoroutine(gavelRoutine); gavelRoutine = StartCoroutine(GavelStrike(1)); }
        }

        private void PauseEffect(bool paused)
        {
            for (int i = 0; i < lights.Length; i++) if (lights[i] != null) lights[i].intensity = baseIntensity != null && i < baseIntensity.Length ? baseIntensity[i] * (paused ? 0.35f : 1f) : lights[i].intensity;
            if (paused) ShowBanner("PAUSED", "THE HOST WILL RESUME THE AUCTION", new Color(0.6f, 0.75f, 1f), false);
            else HideBanner();
        }

        private void CompleteEffect(bool animate)
        {
            ShowBanner("AUCTION", "COMPLETE", Gold, animate);
            if (cameraRig != null) cameraRig.Finale(true);
            if (animate && confetti != null && quality != null && quality.High)
            {
                var main = confetti.main;
                main.startColor = new ParticleSystem.MinMaxGradient(Gold, Color.white);
                confetti.Emit(350);
            }
        }

        private void ShowBanner(string title, string sub, Color color, bool animate)
        {
            if (bannerRoutine != null) StopCoroutine(bannerRoutine);
            screen.overlay.text = title;
            screen.overlay.color = color;
            screen.overlaySub.text = sub;
            screen.overlaySub.color = Color.white;
            SetMainTextVisible(false);
            if (animate) bannerRoutine = StartCoroutine(Punch(screen.overlay.transform));
            else screen.overlay.transform.localScale = Vector3.one;
        }

        private void HideBanner()
        {
            if (bannerRoutine != null) StopCoroutine(bannerRoutine);
            screen.overlay.text = "";
            screen.overlaySub.text = "";
            SetMainTextVisible(true);
        }

        private void SetMainTextVisible(bool visible)
        {
            foreach (var t in new[] { screen.name, screen.role, screen.basePrice, screen.bidCaption, screen.bid, screen.bidder })
                t.gameObject.SetActive(visible);
        }

        private IEnumerator Punch(Transform t)
        {
            float d = 0f;
            while (d < 0.45f)
            {
                d += Time.deltaTime;
                float k = d / 0.45f;
                float s = Mathf.LerpUnclamped(2.2f, 1f, 1f - Mathf.Pow(1f - k, 3f));
                t.localScale = Vector3.one * s;
                yield return null;
            }
            t.localScale = Vector3.one;
        }

        private IEnumerator GavelStrike(int strikes)
        {
            for (int n = 0; n < strikes; n++)
            {
                for (float a = 0; a < 1f; a += Time.deltaTime * 6f) { gavel.localRotation = Quaternion.Euler(-55f * a, 0, 0); yield return null; }
                for (float a = 1f; a > 0f; a -= Time.deltaTime * 12f) { gavel.localRotation = Quaternion.Euler(-55f * a, 0, 0); yield return null; }
                gavel.localRotation = Quaternion.identity;
                yield return new WaitForSeconds(0.12f);
            }
        }

        private void Update()
        {
            // bid "punch" on the amount, and a red pulse on the screen near the end of the timer
            if (bidPunch > 0f)
            {
                bidPunch = Mathf.Max(0f, bidPunch - Time.deltaTime * 2.5f);
                screen.bid.transform.localScale = Vector3.one * (1f + 0.25f * bidPunch);
            }
            if (screen.panel != null)
            {
                var mat = screen.panel.sharedMaterial;
                var baseCol = new Color(0.05f, 0.09f, 0.22f);
                if (warning)
                {
                    float p = 0.5f + 0.5f * Mathf.Sin(Time.time * 10f);
                    mat.SetColor("_EmissionColor", Color.Lerp(baseCol, new Color(0.5f, 0.05f, 0.05f), p) * 1.4f);
                }
                else mat.SetColor("_EmissionColor", baseCol * 1.2f);
            }
        }
    }
}
