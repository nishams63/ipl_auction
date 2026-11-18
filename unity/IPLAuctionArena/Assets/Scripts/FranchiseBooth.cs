using UnityEngine;

namespace IplArena
{
    // One franchise seating area. Visual only.
    public class FranchiseBooth : MonoBehaviour
    {
        public string code;
        public Material deskMaterial, boardMaterial, glowMaterial;
        public TextMesh boardLabel, signLabel, infoLabel;
        private Color primary = Color.gray;
        private bool leader;
        private bool claimed = true;
        private float flash;

        public void ApplyColors(Color main, Color secondary)
        {
            primary = main;
            if (deskMaterial != null) deskMaterial.color = Color.Lerp(secondary, Color.black, 0.35f);
            if (boardMaterial != null) boardMaterial.color = Color.Lerp(main, Color.black, 0.55f);
            UpdateGlow();
        }

        public void SetInfo(string label, float purse, int squad, bool isClaimed)
        {
            claimed = isClaimed;
            if (boardLabel != null) boardLabel.text = label;
            if (signLabel != null) { signLabel.text = label; signLabel.color = isClaimed ? Color.white : new Color(1, 1, 1, 0.35f); }
            if (infoLabel != null) infoLabel.text = isClaimed ? string.Format("Rs {0:0.00} Cr - {1} players", purse, squad) : "not playing";
            UpdateGlow();
        }

        public void SetLeader(bool isLeader)
        {
            if (leader == isLeader) return;
            leader = isLeader;
            UpdateGlow();
        }

        public void Flash() { flash = 1f; }

        private void Update()
        {
            if (flash <= 0f) return;
            flash = Mathf.Max(0f, flash - Time.deltaTime * 1.6f);
            UpdateGlow();
        }

        private void UpdateGlow()
        {
            if (glowMaterial == null) return;
            float level = !claimed ? 0.15f : leader ? 3.2f : 0.9f;
            level += flash * 4f;
            glowMaterial.SetColor("_EmissionColor", primary * level);
        }
    }

    // Keeps a sign turned towards the active camera (yaw only)
    public class Billboard : MonoBehaviour
    {
        private void LateUpdate()
        {
            var cam = Camera.main;
            if (cam == null) return;
            var d = transform.position - cam.transform.position;
            d.y = 0;
            if (d.sqrMagnitude > 0.001f) transform.rotation = Quaternion.LookRotation(d);
        }
    }
}
