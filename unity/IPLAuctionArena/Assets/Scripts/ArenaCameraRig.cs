using UnityEngine;

namespace IplArena
{
    // Cinematic camera: slow orbit of the hall, with short cuts to the stage, a booth or the screen.
    public class ArenaCameraRig : MonoBehaviour
    {
        public ArenaQuality quality;
        public Transform[] boothTargets;
        public bool reducedMotion;

        private static readonly Vector3 Focus = new Vector3(0, 4.5f, 12);
        private static readonly Vector3 ScreenPoint = new Vector3(0, 6.6f, 16);
        private Vector3 shotPos, shotLook;
        private float shotUntil;
        private Vector3 velocity;
        private Vector3 lookCurrent = Focus;
        private float orbit;
        private bool finale;

        public void ShotStage(float seconds) { Shot(new Vector3(0, 5.2f, -1f), ScreenPoint + Vector3.down * 0.6f, seconds); }
        public void ShotScreen(float seconds) { Shot(new Vector3(0, 6.4f, 4.5f), ScreenPoint, seconds); }
        public void Finale(bool on) { finale = on; shotUntil = 0; }

        public void ShotBooth(int index, float seconds)
        {
            if (reducedMotion || boothTargets == null || index < 0 || index >= boothTargets.Length) return;
            var b = boothTargets[index];
            var toward = (Focus - b.position); toward.y = 0; toward.Normalize();
            Shot(b.position + toward * 7f + Vector3.up * 3.2f, b.position + Vector3.up * 2f, seconds);
        }

        private void Shot(Vector3 pos, Vector3 look, float seconds)
        {
            shotPos = pos; shotLook = look; shotUntil = Time.time + seconds;
        }

        private void LateUpdate()
        {
            Vector3 targetPos, targetLook;
            if (Time.time < shotUntil)
            {
                targetPos = shotPos; targetLook = shotLook;
            }
            else
            {
                float speed = reducedMotion ? 0f : (finale ? 0.18f : 0.05f);
                orbit += Time.deltaTime * speed;
                float amp = finale ? 40f : 14f;
                float ang = Mathf.Sin(orbit) * amp * Mathf.Deg2Rad;
                float radius = finale ? 30f : 34f;
                targetPos = new Vector3(Mathf.Sin(ang) * radius, finale ? 13f : 10f, Focus.z - Mathf.Cos(ang) * radius);
                targetLook = Focus;
            }
            float smooth = reducedMotion ? 0.05f : 0.6f;
            transform.position = Vector3.SmoothDamp(transform.position, targetPos, ref velocity, smooth);
            lookCurrent = Vector3.Lerp(lookCurrent, targetLook, 1f - Mathf.Exp(-4f * Time.deltaTime));
            transform.rotation = Quaternion.LookRotation(lookCurrent - transform.position);
        }
    }
}
