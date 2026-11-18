using System.Collections.Generic;
using UnityEngine;

namespace IplArena
{
    // Builds the whole auction hall at runtime from Unity primitives, materials, lights and built-in
    // text: no imported models, textures or third-party assets. Original design; franchises are
    // shown as text abbreviations in their colours (no official logos).
    public class ArenaBuilder : MonoBehaviour
    {
        [Header("Base materials (assigned by IPL Arena > Prepare Scene so their shaders ship in the build)")]
        public Material litBase;
        public Material emissiveBase;
        public Material unlitBase;
        public Material particleBase;

        [Header("Built-in primitive meshes (assigned by Prepare Scene). Using meshes directly avoids the\n" +
                "colliders CreatePrimitive adds: physics is stripped from the WebGL build, so those fail.")]
        public Mesh cubeMesh;
        public Mesh cylinderMesh;
        public Mesh sphereMesh;
        public Mesh quadMesh;
        public Mesh planeMesh;
        public Mesh capsuleMesh;

        public static readonly string[] DefaultFranchises = { "CSK", "MI", "RCB", "KKR", "SRH", "RR", "DC", "PBKS", "GT", "LSG" };

        private Font font;
        private Transform root;
        private Transform staticRoot;
        private readonly List<Material> created = new List<Material>();

        private void Awake()
        {
            font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            Build();
        }

        private void OnDestroy()
        {
            foreach (var m in created) if (m != null) Destroy(m);
        }

        // ── materials ──────────────────────────────────────────────────────
        private Material Make(Material baseMat, string fallbackShader)
        {
            var m = baseMat != null ? new Material(baseMat) : new Material(Shader.Find(fallbackShader));
            created.Add(m);
            return m;
        }

        public Material Lit(Color c, float smoothness = 0.3f, float metallic = 0f)
        {
            var m = Make(litBase, "Standard");
            m.color = c;
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", smoothness);
            if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", metallic);
            return m;
        }

        public Material Emissive(Color c, float intensity)
        {
            var m = Make(emissiveBase, "Standard");
            m.color = c * 0.4f;
            m.EnableKeyword("_EMISSION");
            if (m.HasProperty("_EmissionColor")) m.SetColor("_EmissionColor", c * intensity);
            return m;
        }

        public Material Unlit(Color c)
        {
            var m = Make(unlitBase, "Unlit/Color");
            m.color = c;
            return m;
        }

        public Material Particle()
        {
            return Make(particleBase, "Particles/Standard Unlit");
        }

        // ── primitives ─────────────────────────────────────────────────────
        private Mesh MeshFor(PrimitiveType type)
        {
            Mesh m;
            string builtin;
            switch (type)
            {
                case PrimitiveType.Cube: m = cubeMesh; builtin = "Cube.fbx"; break;
                case PrimitiveType.Cylinder: m = cylinderMesh; builtin = "Cylinder.fbx"; break;
                case PrimitiveType.Sphere: m = sphereMesh; builtin = "Sphere.fbx"; break;
                case PrimitiveType.Quad: m = quadMesh; builtin = "Quad.fbx"; break;
                case PrimitiveType.Plane: m = planeMesh; builtin = "Plane.fbx"; break;
                default: m = capsuleMesh; builtin = "Capsule.fbx"; break;
            }
            if (m == null) m = Resources.GetBuiltinResource<Mesh>(builtin);
            return m;
        }

        public GameObject Shape(PrimitiveType type, string name, Transform parent, Vector3 pos, Vector3 scale, Material mat, Quaternion? rot = null)
        {
            GameObject go;
            var mesh = MeshFor(type);
            if (mesh != null)
            {
                go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
                go.GetComponent<MeshFilter>().sharedMesh = mesh;
            }
            else
            {
                go = GameObject.CreatePrimitive(type); // last resort (editor without assigned meshes)
                go.name = name;
            }
            go.transform.SetParent(parent, false);
            go.transform.localPosition = pos;
            go.transform.localRotation = rot ?? Quaternion.identity;
            go.transform.localScale = scale;
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = mat;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = true;
            return go;
        }

        public TextMesh Label(Transform parent, string text, Vector3 pos, float height, Color color, TextAnchor anchor = TextAnchor.MiddleCenter, FontStyle style = FontStyle.Bold)
        {
            var go = new GameObject("Text");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = pos;
            var tm = go.AddComponent<TextMesh>();
            tm.font = font;
            tm.fontSize = 96;
            tm.characterSize = height * 10f / 96f;
            tm.anchor = anchor;
            tm.alignment = TextAlignment.Center;
            tm.fontStyle = style;
            tm.color = color;
            tm.text = text;
            var mr = go.GetComponent<MeshRenderer>();
            mr.sharedMaterial = font.material;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return tm;
        }

        public static Color Hex(string hex, Color fallback)
        {
            Color c;
            return !string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out c) ? c : fallback;
        }

        // ── the hall ───────────────────────────────────────────────────────
        private void Build()
        {
            root = new GameObject("Arena").transform;
            staticRoot = new GameObject("Static").transform;
            staticRoot.SetParent(root, false);

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.10f, 0.12f, 0.22f);
            RenderSettings.ambientEquatorColor = new Color(0.06f, 0.06f, 0.12f);
            RenderSettings.ambientGroundColor = new Color(0.02f, 0.02f, 0.04f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogColor = new Color(0.02f, 0.03f, 0.07f);
            RenderSettings.fogDensity = 0.012f;

            var navy = new Color(0.04f, 0.06f, 0.13f);
            var gold = new Color(1f, 0.76f, 0.25f);

            // Floor, walls, ceiling
            Shape(PrimitiveType.Cube, "Floor", staticRoot, new Vector3(0, -0.05f, 2), new Vector3(64, 0.1f, 48), Lit(new Color(0.05f, 0.06f, 0.10f), 0.85f, 0.1f));
            Shape(PrimitiveType.Cube, "Carpet", staticRoot, new Vector3(0, 0.005f, -2), new Vector3(30, 0.01f, 22), Lit(new Color(0.18f, 0.04f, 0.08f), 0.15f));
            Shape(PrimitiveType.Cube, "BackWall", staticRoot, new Vector3(0, 8, 19), new Vector3(64, 16, 0.5f), Lit(navy, 0.4f));
            Shape(PrimitiveType.Cube, "LeftWall", staticRoot, new Vector3(-32, 8, 2), new Vector3(0.5f, 16, 48), Lit(navy, 0.4f));
            Shape(PrimitiveType.Cube, "RightWall", staticRoot, new Vector3(32, 8, 2), new Vector3(0.5f, 16, 48), Lit(navy, 0.4f));
            Shape(PrimitiveType.Cube, "Ceiling", staticRoot, new Vector3(0, 16, 2), new Vector3(64, 0.4f, 48), Lit(new Color(0.02f, 0.02f, 0.04f)));

            // Vertical light strips on the walls (emissive, no light cost)
            var stripMat = Emissive(new Color(0.25f, 0.45f, 1f), 1.6f);
            for (int i = 0; i < 8; i++)
            {
                float z = -18 + i * 5f;
                Shape(PrimitiveType.Cube, "StripL", staticRoot, new Vector3(-31.6f, 7, z), new Vector3(0.1f, 12, 0.25f), stripMat);
                Shape(PrimitiveType.Cube, "StripR", staticRoot, new Vector3(31.6f, 7, z), new Vector3(0.1f, 12, 0.25f), stripMat);
            }

            // Stage
            Shape(PrimitiveType.Cube, "Stage", staticRoot, new Vector3(0, 0.45f, 13), new Vector3(20, 0.9f, 8), Lit(new Color(0.08f, 0.09f, 0.16f), 0.7f, 0.2f));
            Shape(PrimitiveType.Cube, "StageEdge", staticRoot, new Vector3(0, 0.92f, 9.02f), new Vector3(20, 0.06f, 0.08f), Emissive(gold, 2.2f));
            for (int i = 0; i < 3; i++)
                Shape(PrimitiveType.Cube, "Step", staticRoot, new Vector3(0, 0.15f + i * 0.3f, 8.4f - i * 0.0f - (2 - i) * 0.4f), new Vector3(6, 0.3f, 0.4f), Lit(new Color(0.07f, 0.08f, 0.14f), 0.6f));

            // LED screen: frame + panel
            Shape(PrimitiveType.Cube, "ScreenFrame", staticRoot, new Vector3(0, 6.6f, 16.3f), new Vector3(17.2f, 8.2f, 0.4f), Lit(new Color(0.03f, 0.03f, 0.05f), 0.9f, 0.6f));
            var screen = Shape(PrimitiveType.Cube, "ScreenPanel", root, new Vector3(0, 6.6f, 16.05f), new Vector3(16.4f, 7.4f, 0.1f), Emissive(new Color(0.05f, 0.09f, 0.22f), 1.2f));

            // Ceiling truss with lamps (geometry) above the stage
            var trussMat = Lit(new Color(0.25f, 0.27f, 0.3f), 0.6f, 0.8f);
            Shape(PrimitiveType.Cube, "TrussFront", staticRoot, new Vector3(0, 13.2f, 7), new Vector3(30, 0.35f, 0.35f), trussMat);
            Shape(PrimitiveType.Cube, "TrussBack", staticRoot, new Vector3(0, 13.2f, 12), new Vector3(30, 0.35f, 0.35f), trussMat);
            var lampMat = Emissive(new Color(1f, 0.95f, 0.85f), 2.5f);
            for (int i = 0; i < 7; i++)
                Shape(PrimitiveType.Cylinder, "Lamp", staticRoot, new Vector3(-12 + i * 4, 12.8f, 7), new Vector3(0.5f, 0.3f, 0.5f), lampMat);

            // Auctioneer lectern + gavel
            var lectern = new GameObject("Lectern").transform;
            lectern.SetParent(root, false);
            lectern.localPosition = new Vector3(-6.5f, 0.9f, 11);
            Shape(PrimitiveType.Cube, "LecternBody", lectern, new Vector3(0, 0.6f, 0), new Vector3(1.6f, 1.2f, 0.9f), Lit(new Color(0.22f, 0.12f, 0.06f), 0.5f));
            Shape(PrimitiveType.Cube, "LecternTop", lectern, new Vector3(0, 1.25f, 0), new Vector3(1.8f, 0.1f, 1.1f), Lit(new Color(0.3f, 0.17f, 0.08f), 0.6f));
            Shape(PrimitiveType.Cube, "LecternBadge", lectern, new Vector3(0, 0.7f, -0.46f), new Vector3(1.2f, 0.18f, 0.02f), Emissive(gold, 2f));
            var gavelPivot = new GameObject("GavelPivot").transform;
            gavelPivot.SetParent(lectern, false);
            gavelPivot.localPosition = new Vector3(0.4f, 1.35f, 0);
            var wood = Lit(new Color(0.35f, 0.18f, 0.07f), 0.5f);
            Shape(PrimitiveType.Cylinder, "Handle", gavelPivot, new Vector3(0, 0.05f, -0.25f), new Vector3(0.05f, 0.25f, 0.05f), wood, Quaternion.Euler(90, 0, 0));
            Shape(PrimitiveType.Cylinder, "Head", gavelPivot, new Vector3(0, 0.05f, -0.5f), new Vector3(0.14f, 0.12f, 0.14f), wood, Quaternion.Euler(0, 0, 90));
            Shape(PrimitiveType.Cylinder, "Block", lectern, new Vector3(0.4f, 1.32f, -0.5f), new Vector3(0.3f, 0.03f, 0.3f), wood);

            // Franchise booths on an arc facing the stage
            var booths = new List<FranchiseBooth>();
            var stageFocus = new Vector3(0, 0, 13);
            for (int i = 0; i < DefaultFranchises.Length; i++)
            {
                float t = i / (float)(DefaultFranchises.Length - 1);
                float ang = Mathf.Lerp(-62f, 62f, t) * Mathf.Deg2Rad;
                var pos = stageFocus + new Vector3(Mathf.Sin(ang) * 17f, 0, -Mathf.Cos(ang) * 17f);
                var booth = new GameObject("Booth_" + DefaultFranchises[i]).transform;
                booth.SetParent(root, false);
                booth.localPosition = pos;
                booth.localRotation = Quaternion.LookRotation(stageFocus - pos);
                booths.Add(BuildBooth(booth, DefaultFranchises[i]));
            }

            // Timer bar under the screen
            var timerRoot = new GameObject("TimerBar").transform;
            timerRoot.SetParent(root, false);
            timerRoot.localPosition = new Vector3(0, 2.45f, 15.95f);
            var segments = new Renderer[20];
            var segMat = Emissive(new Color(0.2f, 0.9f, 0.5f), 2f);
            for (int i = 0; i < segments.Length; i++)
                segments[i] = Shape(PrimitiveType.Cube, "Seg" + i, timerRoot, new Vector3(-7.6f + i * 0.8f, 0, 0), new Vector3(0.62f, 0.18f, 0.05f), segMat).GetComponent<Renderer>();

            // Screen texts (face the hall: TextMesh is readable from its -Z side)
            var st = new GameObject("ScreenText").transform;
            st.SetParent(root, false);
            st.localPosition = new Vector3(0, 6.6f, 15.95f);
            var refs = new ScreenRefs
            {
                panel = screen.GetComponent<Renderer>(),
                lotLine = Label(st, "IPL AUCTION", new Vector3(0, 3.0f, 0), 0.38f, new Color(0.7f, 0.8f, 1f)),
                name = Label(st, "WAITING FOR THE FIRST LOT", new Vector3(0, 1.75f, 0), 0.95f, Color.white),
                role = Label(st, "", new Vector3(0, 0.75f, 0), 0.42f, new Color(0.75f, 0.85f, 1f), TextAnchor.MiddleCenter, FontStyle.Normal),
                basePrice = Label(st, "", new Vector3(0, 0.05f, 0), 0.42f, new Color(0.8f, 0.8f, 0.85f), TextAnchor.MiddleCenter, FontStyle.Normal),
                bidCaption = Label(st, "CURRENT BID", new Vector3(0, -0.75f, 0), 0.3f, new Color(1f, 0.85f, 0.5f)),
                bid = Label(st, "—", new Vector3(0, -1.6f, 0), 1.05f, gold),
                bidder = Label(st, "", new Vector3(0, -2.65f, 0), 0.55f, Color.white),
                timer = Label(st, "", new Vector3(6.6f, 2.75f, 0), 0.9f, new Color(0.3f, 1f, 0.6f)),
                overlay = Label(st, "", new Vector3(0, 0, -0.6f), 2.1f, Color.white),
                overlaySub = Label(st, "", new Vector3(0, -1.6f, -0.6f), 0.6f, Color.white),
                segments = segments,
                segmentMaterial = segMat
            };

            // Lights: one key spot (the only shadow caster, high quality only), fills without shadows
            var lights = new List<Light>();
            var key = MakeLight(LightType.Spot, new Vector3(0, 13, 4), Quaternion.Euler(55, 0, 0), new Color(1f, 0.95f, 0.88f), 3.2f, 40f, 55f);
            lights.Add(key);
            lights.Add(MakeLight(LightType.Spot, new Vector3(-10, 12, 6), Quaternion.Euler(60, 25, 0), new Color(0.55f, 0.65f, 1f), 1.8f, 34f, 60f));
            lights.Add(MakeLight(LightType.Spot, new Vector3(10, 12, 6), Quaternion.Euler(60, -25, 0), new Color(1f, 0.6f, 0.45f), 1.8f, 34f, 60f));
            lights.Add(MakeLight(LightType.Directional, Vector3.zero, Quaternion.Euler(50, 30, 0), new Color(0.35f, 0.4f, 0.6f), 0.35f, 0, 0));

            // Effects
            var confetti = BuildConfetti();
            var cam = BuildCamera();

            // Static batching of everything that never moves
            StaticBatchingUtility.Combine(staticRoot.gameObject);

            // Wire up behaviour
            var quality = gameObject.AddComponent<ArenaQuality>();
            quality.keyLight = key;
            quality.lights = lights.ToArray();
            quality.confetti = confetti;
            var rig = cam.gameObject.AddComponent<ArenaCameraRig>();
            rig.quality = quality;
            rig.boothTargets = booths.ConvertAll(b => b.transform).ToArray();
            quality.cameraRig = rig;
            var presenter = gameObject.AddComponent<ArenaPresenter>();
            presenter.screen = refs;
            presenter.booths = booths.ToArray();
            presenter.gavel = gavelPivot;
            presenter.cameraRig = rig;
            presenter.confetti = confetti;
            presenter.quality = quality;
            presenter.lights = lights.ToArray();
            presenter.builder = this;

            var bridge = FindFirstObjectByType<ArenaBridge>();
            if (bridge == null) bridge = new GameObject("ArenaBridge").AddComponent<ArenaBridge>();
            bridge.presenter = presenter;
            bridge.quality = quality;
        }

        private FranchiseBooth BuildBooth(Transform booth, string code)
        {
            var b = booth.gameObject.AddComponent<FranchiseBooth>();
            var baseColor = new Color(0.3f, 0.33f, 0.4f);
            b.deskMaterial = Lit(baseColor * 0.5f, 0.5f, 0.2f);
            b.boardMaterial = Lit(baseColor * 0.35f, 0.3f);
            b.glowMaterial = Emissive(baseColor, 1.2f);
            Shape(PrimitiveType.Cube, "Desk", booth, new Vector3(0, 0.55f, 0.6f), new Vector3(3.4f, 1.1f, 0.9f), b.deskMaterial);
            Shape(PrimitiveType.Cube, "Glow", booth, new Vector3(0, 1.12f, 0.6f), new Vector3(3.4f, 0.06f, 0.95f), b.glowMaterial);
            Shape(PrimitiveType.Cube, "Board", booth, new Vector3(0, 1.8f, -1.3f), new Vector3(3.6f, 3.6f, 0.15f), b.boardMaterial);
            var chairMat = Lit(new Color(0.08f, 0.08f, 0.1f), 0.4f);
            for (int s = -1; s <= 1; s++)
                Shape(PrimitiveType.Cylinder, "Seat", booth, new Vector3(s * 1.0f, 0.35f, -0.3f), new Vector3(0.6f, 0.35f, 0.6f), chairMat);
            // label on the board; billboarded so it reads correctly from the hall camera behind the
            // booths and from the stage-side booth close-ups (TextMesh is visible from both sides)
            var boardPivot = new GameObject("BoardLabel").transform;
            boardPivot.SetParent(booth, false);
            boardPivot.localPosition = new Vector3(0, 2.6f, -1.2f);
            boardPivot.gameObject.AddComponent<Billboard>();
            b.boardLabel = Label(boardPivot, code, Vector3.zero, 0.75f, Color.white);
            // floating sign for the hall cameras (billboarded)
            var sign = new GameObject("Sign").transform;
            sign.SetParent(booth, false);
            sign.localPosition = new Vector3(0, 4.3f, -1.3f);
            sign.gameObject.AddComponent<Billboard>();
            b.signLabel = Label(sign, code, new Vector3(0, 0.25f, 0), 0.7f, Color.white);
            b.infoLabel = Label(sign, "", new Vector3(0, -0.45f, 0), 0.3f, new Color(0.85f, 0.88f, 0.95f), TextAnchor.MiddleCenter, FontStyle.Normal);
            b.code = code;
            b.ApplyColors(baseColor, baseColor * 0.5f);
            return b;
        }

        private Light MakeLight(LightType type, Vector3 pos, Quaternion rot, Color color, float intensity, float range, float angle)
        {
            var go = new GameObject(type + "Light");
            go.transform.SetParent(root, false);
            go.transform.localPosition = pos;
            go.transform.localRotation = rot;
            var l = go.AddComponent<Light>();
            l.type = type;
            l.color = color;
            l.intensity = intensity;
            if (type == LightType.Spot) { l.range = range; l.spotAngle = angle; }
            l.shadows = LightShadows.None;
            return l;
        }

        private ParticleSystem BuildConfetti()
        {
            var go = new GameObject("Confetti");
            go.transform.SetParent(root, false);
            go.transform.localPosition = new Vector3(0, 12, 11);
            go.transform.localRotation = Quaternion.Euler(90, 0, 0);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var main = ps.main;
            main.playOnAwake = false;
            main.loop = false;
            main.duration = 2f;
            main.startLifetime = 3.5f;
            main.startSpeed = new ParticleSystem.MinMaxCurve(2f, 6f);
            main.startSize = new ParticleSystem.MinMaxCurve(0.08f, 0.18f);
            main.gravityModifier = 0.35f;
            main.maxParticles = 400;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            var emission = ps.emission;
            emission.rateOverTime = 0;
            var shape = ps.shape;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(14, 4, 1);
            var renderer = go.GetComponent<ParticleSystemRenderer>();
            renderer.sharedMaterial = Particle();
            return ps;
        }

        private Camera BuildCamera()
        {
            var existing = Camera.main;
            Camera cam = existing != null ? existing : new GameObject("Main Camera").AddComponent<Camera>();
            cam.gameObject.tag = "MainCamera";
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.01f, 0.015f, 0.035f);
            cam.fieldOfView = 45;
            cam.nearClipPlane = 0.3f;
            cam.farClipPlane = 120;
            cam.allowMSAA = true;
            cam.transform.position = new Vector3(0, 10, -22);
            cam.transform.LookAt(new Vector3(0, 4.5f, 12));
            return cam;
        }
    }

    public class ScreenRefs
    {
        public Renderer panel;
        public TextMesh lotLine, name, role, basePrice, bidCaption, bid, bidder, timer, overlay, overlaySub;
        public Renderer[] segments;
        public Material segmentMaterial;
    }
}
