using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace IplArena.Editor
{
    // Menu + batch-mode entry points. Everything here uses built-in Unity features only.
    //   Unity.exe -batchmode -quit -projectPath <this project> -executeMethod IplArena.Editor.ArenaBuild.CompileCheck -logFile compile.log
    //   ... -executeMethod IplArena.Editor.ArenaBuild.BuildWebGL   (needs the free "WebGL Build Support" module)
    public static class ArenaBuild
    {
        private const string ScenePath = "Assets/Scenes/Arena.unity";
        private const string MaterialDir = "Assets/Materials";
        // Output goes straight into the React app's static folder so Vite/Vercel serve it at /unity/arena/
        private const string WebGLOut = "../../client/public/unity/arena";

        [MenuItem("IPL Arena/1. Prepare Scene")]
        public static void PrepareScene()
        {
            Directory.CreateDirectory(MaterialDir);
            Directory.CreateDirectory("Assets/Scenes");
            var lit = MaterialAsset("ArenaLit", "Standard", null);
            var emissive = MaterialAsset("ArenaEmissive", "Standard", m => { m.EnableKeyword("_EMISSION"); m.SetColor("_EmissionColor", Color.white); m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive; });
            var unlit = MaterialAsset("ArenaUnlit", "Unlit/Color", null);
            var particle = MaterialAsset("ArenaParticle", "Particles/Standard Unlit", null);
            AssetDatabase.SaveAssets();

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.16f, 0.18f, 0.26f);
            RenderSettings.skybox = null;
            new GameObject("ArenaBridge").AddComponent<ArenaBridge>();
            var root = new GameObject("ArenaRoot").AddComponent<ArenaBuilder>();
            root.litBase = lit; root.emissiveBase = emissive; root.unlitBase = unlit; root.particleBase = particle;
            root.cubeMesh = BuiltinMesh(PrimitiveType.Cube); root.cylinderMesh = BuiltinMesh(PrimitiveType.Cylinder);
            root.sphereMesh = BuiltinMesh(PrimitiveType.Sphere); root.quadMesh = BuiltinMesh(PrimitiveType.Quad);
            root.planeMesh = BuiltinMesh(PrimitiveType.Plane); root.capsuleMesh = BuiltinMesh(PrimitiveType.Capsule);
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };

            PlayerSettings.companyName = "IPL Auction";
            PlayerSettings.productName = "IPL Arena";
            PlayerSettings.colorSpace = ColorSpace.Gamma; // WebGL1/low-end friendly
            PlayerSettings.runInBackground = true;
            PlayerSettings.stripEngineCode = true;
            Debug.Log("ARENA_SCENE_READY " + ScenePath);
        }

        // The built-in primitive mesh, taken from a temporary primitive so it works in every Unity version
        private static Mesh BuiltinMesh(PrimitiveType type)
        {
            var tmp = GameObject.CreatePrimitive(type);
            var mesh = tmp.GetComponent<MeshFilter>().sharedMesh;
            UnityEngine.Object.DestroyImmediate(tmp);
            return mesh;
        }

        private static Material MaterialAsset(string name, string shader, Action<Material> setup)
        {
            var path = MaterialDir + "/" + name + ".mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            var s = Shader.Find(shader);
            if (s == null) throw new Exception("Built-in shader not found: " + shader);
            if (m == null) { m = new Material(s); AssetDatabase.CreateAsset(m, path); }
            else m.shader = s;
            setup?.Invoke(m);
            EditorUtility.SetDirty(m);
            return m;
        }

        // Batch-mode compile verification: if this method runs at all, every script compiled.
        public static void CompileCheck()
        {
            var types = new[] { typeof(ArenaBuilder), typeof(ArenaPresenter), typeof(ArenaBridge), typeof(ArenaQuality), typeof(ArenaCameraRig), typeof(FranchiseBooth), typeof(ArenaState) };
            Debug.Log("COMPILE_OK " + string.Join(",", types.Select(t => t.Name)));
            // A quick round-trip of the protocol parser, without a scene
            var s = JsonUtility.FromJson<ArenaState>("{\"v\":1,\"status\":\"active\",\"hasLot\":true,\"lot\":{\"name\":\"Test\",\"basePrice\":2},\"franchises\":[{\"id\":\"CSK\",\"code\":\"CSK\",\"purse\":120}]}");
            if (s == null || s.v != 1 || s.lot.name != "Test" || s.franchises.Length != 1) { Debug.LogError("PROTOCOL_PARSE_FAILED"); Exit(1); return; }
            Debug.Log("PROTOCOL_PARSE_OK");
            Exit(0);
        }

        [MenuItem("IPL Arena/2. Build Windows (verification)")]
        public static void BuildWindows()
        {
            RegenerateScene();
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath }, locationPathName = "Builds/Win64/IPLArena.exe",
                target = BuildTarget.StandaloneWindows64, options = BuildOptions.None
            });
            Finish(report);
        }

        [MenuItem("IPL Arena/3. Build WebGL (into the React client)")]
        public static void BuildWebGL()
        {
            if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL))
            {
                Debug.LogError("WEBGL_MODULE_MISSING: install 'WebGL Build Support' for this editor in Unity Hub (free) and run again.");
                Exit(2);
                return;
            }
            RegenerateScene();
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true; // static hosts without Content-Encoding headers still work
            PlayerSettings.WebGL.template = "APPLICATION:Minimal";
            PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.ExplicitlyThrownExceptionsOnly;
            // Off on purpose: Unity's IndexedDB cache served a stale .data file to new code after a rebuild
            // (BoxCollider errors + stack overflow in the browser). 0.8 MB of data is fine for the normal
            // HTTP cache, which revalidates correctly.
            PlayerSettings.WebGL.dataCaching = false;
            PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.WebGL, ManagedStrippingLevel.High);
            PlayerSettings.SetIl2CppCodeGeneration(NamedBuildTarget.WebGL, Il2CppCodeGeneration.OptimizeSize);
            // Small scene: start at 64 MB and grow on demand, capped well below what low-end laptops allow a tab
            PlayerSettings.WebGL.initialMemorySize = 64;
            PlayerSettings.WebGL.memoryGrowthMode = WebGLMemoryGrowthMode.Geometric;
            PlayerSettings.WebGL.maximumMemorySize = 512;
            PlayerSettings.WebGL.nameFilesAsHashes = false; // stable names: arena.loader.js, arena.wasm.unityweb ...
            PlayerSettings.WebGL.showDiagnostics = false;
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath }, locationPathName = WebGLOut,
                target = BuildTarget.WebGL, options = BuildOptions.None
            });
            Finish(report);
        }

        private static void RegenerateScene()
        {
            // Always regenerate: the scene is fully produced by PrepareScene, and this keeps
            // materials/meshes in sync with the scripts (the scene holds no hand-made content).
            PrepareScene();
        }

        private static void Finish(BuildReport report)
        {
            var sum = report.summary;
            // Unity can report "Succeeded" while a post-process step logged errors (e.g. a platform module
            // installed while the editor was open): treat any error as a failed build.
            bool ok = sum.result == BuildResult.Succeeded && sum.totalErrors == 0;
            var msg = string.Format("BUILD_RESULT {0} unityResult={1} size={2} errors={3} warnings={4} out={5}", ok ? "OK" : "FAILED", sum.result, sum.totalSize, sum.totalErrors, sum.totalWarnings, sum.outputPath);
            if (ok) Debug.Log(msg); else Debug.LogError(msg);
            Exit(ok ? 0 : 1);
        }

        private static void Exit(int code)
        {
            if (Application.isBatchMode) EditorApplication.Exit(code);
        }
    }
}
