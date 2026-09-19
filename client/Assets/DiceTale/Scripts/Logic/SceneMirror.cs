using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 场景镜像：**后台有什么对象，前端就有什么对象**。
    ///
    /// 收到 `scene_sync`（整份场景）后：
    /// - 场景名变了 → 整场景换（旧对象全销毁）；
    /// - 否则按 `id` **增 / 改 / 删**：新 id 建视图、老 id 更新属性、名单里没有的销毁；
    /// - 属性逐项同步（位置 / 旋转 / 缩放 / **激活** / 显示顺序 / 名字），有图就去取图。
    ///
    /// 同时把这份模型留一份（<see cref="Find"/>），因为命令是**触发器**：比如播放声音时，
    /// 前端要能读出那个对象自己声明的 `sound.picked`——数据在镜像里，不在命令里。
    ///
    /// 视图都挂在镜像根节点下（`mirrorRoot`），层级里一眼能看出「这些是后台推下来的对象」。
    /// </summary>
    public class SceneMirror : MonoBehaviour
    {
        private readonly Dictionary<string, SceneObjectView> views = new Dictionary<string, SceneObjectView>();
        private readonly Dictionary<string, MirrorObject> objects = new Dictionary<string, MirrorObject>();

        private Transform mirrorRoot;
        private ResourceImageLoader imageLoader;
        private ClientSession session;

        /// <summary>当前镜像的场景名（null = 还没镜像任何场景）。</summary>
        public string SceneName { get; private set; }

        /// <summary>镜像里的对象数。</summary>
        public int ObjectCount => objects.Count;

        /// <summary>接上会话（由 <see cref="BackendManager"/> 调用一次）。</summary>
        public void Initialize(ClientSession clientSession, ResourceImageLoader loader)
        {
            session = clientSession;
            imageLoader = loader;

            var root = new GameObject("镜像场景");
            root.transform.SetParent(transform, false);
            mirrorRoot = root.transform;

            session.SceneReceived += Apply;
        }

        private void OnDestroy()
        {
            if (session != null)
            {
                session.SceneReceived -= Apply;
            }
        }

        /// <summary>按 id 找到镜像里的对象（命令要用它取数据）；没有返回 null。</summary>
        public MirrorObject Find(string objectId)
        {
            return objectId != null && objects.TryGetValue(objectId, out var found) ? found : null;
        }

        /// <summary>应用一份场景（`null` = 编辑器没有打开的场景 → 清空镜像）。</summary>
        public void Apply(MirrorScene scene)
        {
            if (scene == null)
            {
                ClearAll();
                SceneName = null;
                Debug.Log("[镜像] 场景已清空（编辑器没有打开的场景）");
                return;
            }

            if (SceneName != null && SceneName != scene.name)
            {
                // 换场景：整场景重来，避免两个场景的对象混在一起
                ClearAll();
            }

            SceneName = scene.name;

            var present = new HashSet<string>();
            foreach (var obj in scene.objects)
            {
                present.Add(obj.id);
                objects[obj.id] = obj;

                if (!views.TryGetValue(obj.id, out var view))
                {
                    view = SceneObjectView.Create(obj, mirrorRoot, imageLoader);
                    views[obj.id] = view;
                }

                view.Apply(obj);
            }

            // 名单里没有的 → 前端也不该有（删除 / 复制后改名都走这里）
            var removed = new List<string>();
            foreach (var id in views.Keys)
            {
                if (!present.Contains(id))
                {
                    removed.Add(id);
                }
            }

            foreach (var id in removed)
            {
                var view = views[id];
                if (view != null)
                {
                    Destroy(view.gameObject);
                }

                views.Remove(id);
                objects.Remove(id);
            }

            Debug.Log(
                $"[镜像] 场景「{scene.name}」：{objects.Count} 个对象" +
                (removed.Count > 0 ? $"，移除 {removed.Count} 个" : ""));
        }

        private void ClearAll()
        {
            foreach (var view in views.Values)
            {
                if (view != null)
                {
                    Destroy(view.gameObject);
                }
            }

            views.Clear();
            objects.Clear();
        }
    }
}
