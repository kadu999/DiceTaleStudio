using System.Collections.Generic;
using UnityEngine;

namespace DiceTale
{
    /// <summary>
    /// 通用整数属性表组件（2026-09-02 加）：一张「名字 + 整数（+ 上限 + 分组）」的列表，
    /// 替代为每个属性单独写字段的硬编码。供玩家等需要多属性展示/后台修改的对象使用。
    ///
    /// 与 <see cref="BackendObject"/> 枢纽挂同一物体，继承 <see cref="BackendComponent"/>：
    /// - 上报：整张属性表（每项 key/maxValue/group/value）经 IBackendComponentData 上报，GM 可渲染/修改；
    /// - 命令：set_int 带 key 字段 → 按名字改对应项值。一个组件管整张表，命令按 objectId 路由到本
    ///   组件后由 key 在表内定位——绕开「多个同 ID 组件无法区分」的协议限制；
    /// - group 仅用于 UI 归类（identity=身份区资源行 / attr=状态页属性 / check=状态页检定），
    ///   后台可按需增删条目、改值，无需改客户端代码。
    ///
    /// 惯例：maxValue &gt; 0 时 UI 显示「当前/上限」（如生命 10/10）；maxValue ≤ 0 只显示当前值（单值属性）。
    /// </summary>
    public class AttributeList : BackendComponent
    {
        /// <summary>组件 ID（GM 面板据此渲染本组件的编辑区）。</summary>
        public override string ComponentId => "AttributeList";

        [SerializeField, Tooltip("属性表：名字 + 当前值 + 上限 + 分组，后台可按 key 修改")]
        private List<AttributeEntry> attributes = new List<AttributeEntry>();

        /// <summary>属性表只读视图。</summary>
        public IReadOnlyList<AttributeEntry> Attributes => attributes;

        /// <summary>按 key（忽略大小写）查属性值；不存在返回 0。</summary>
        public int GetValue(string key)
        {
            var entry = Find(key);
            return entry != null ? entry.Value : 0;
        }

        /// <summary>按 key 查是否存在。</summary>
        public bool Has(string key)
        {
            return Find(key) != null;
        }

        /// <summary>按分组取属性（UI 渲染用；保持表内顺序）。</summary>
        public List<AttributeEntry> GetByGroup(string group)
        {
            var result = new List<AttributeEntry>();
            foreach (var entry in attributes)
            {
                if (string.Equals(entry.Group, group, System.StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(entry);
                }
            }

            return result;
        }

        /// <summary>本地设置值（不改列表结构；key 不存在时忽略）。值实际变化才触发 <see cref="BackendComponent.Changed"/>。</summary>
        public void SetValue(string key, int value)
        {
            var entry = Find(key);
            if (entry == null || entry.Value == value)
            {
                return;
            }

            entry.Value = value;
            NotifyChanged();
        }

        /// <summary>整体替换属性表（创建角色时按后端角色卡初始化）；替换即触发变更通知。
        /// 属性条目类型固定（key/group/value/maxValue），后续改卡内数值即可。</summary>
        public void ReplaceAttributes(IEnumerable<AttributeDef> newAttributes)
        {
            attributes.Clear();
            if (newAttributes != null)
            {
                foreach (var def in newAttributes)
                {
                    if (def == null || string.IsNullOrEmpty(def.key))
                    {
                        continue;
                    }

                    attributes.Add(new AttributeEntry(def.key, def.group, def.value, def.maxValue));
                }
            }

            NotifyChanged();
        }

        /// <summary>组件数据上报：整张属性表（GM 属性面板按 key 渲染，JSON 键 attributes）。</summary>
        public override void AppendToInfo(Server.ServerObjectInfo info)
        {
            var data = new AttributeListData();
            foreach (var entry in attributes)
            {
                data.attributes.Add(new AttributeData
                {
                    key = entry.Key,
                    group = entry.Group,
                    value = entry.Value,
                    maxValue = entry.MaxValue
                });
            }

            AppendData(info, data);
        }

        [System.Serializable]
        private class AttributeListData
        {
            public List<AttributeData> attributes = new List<AttributeData>();
        }

        [System.Serializable]
        private class AttributeData
        {
            public string key;
            public string group;
            public int value;
            public int maxValue;
        }

        /// <summary>命令处理：set_int（GM 整数输入框修改；带 key 字段定位到具体属性）。</summary>
        public override bool CanHandle(string commandType) => commandType == "set_int";

        public override bool HandleCommand(Dictionary<string, object> msg)
        {
            var key = Server.JsonParser.GetString(msg, "key");
            if (string.IsNullOrEmpty(key) || Find(key) == null)
            {
                return false;
            }

            SetValue(key, (int)Server.JsonParser.GetNumber(msg, "value"));
            return true;
        }

        private AttributeEntry Find(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                return null;
            }

            foreach (var entry in attributes)
            {
                if (string.Equals(entry.Key, key, System.StringComparison.OrdinalIgnoreCase))
                {
                    return entry;
                }
            }

            return null;
        }
    }

    /// <summary>属性表数据条目（角色卡 JSON 下发：key/group/value/maxValue，类型固定，后续只改数值）。</summary>
    [System.Serializable]
    public class AttributeDef
    {
        public string key;
        public string group;
        public int value;
        public int maxValue;

        public AttributeDef() { }

        public AttributeDef(string key, string group, int value, int maxValue)
        {
            this.key = key;
            this.group = group;
            this.value = value;
            this.maxValue = maxValue;
        }
    }

    /// <summary>一条属性：名字（key）+ 当前值 + 上限（0=无上限）+ 分组（identity/attr/check，UI 归类用）。</summary>
    [System.Serializable]
    public class AttributeEntry
    {
        [SerializeField, Tooltip("属性名（后台 set_int 的 key；UI label）")]
        private string key;

        [SerializeField, Tooltip("分组：identity=身份区资源行 / attr=状态页属性 / check=状态页检定")]
        private string group;

        [SerializeField, Tooltip("当前值")]
        private int value;

        [SerializeField, Tooltip("上限（>0 时 UI 显示 当前/上限，如生命 10/10；≤0 只显示当前值）")]
        private int maxValue;

        public AttributeEntry() { }

        public AttributeEntry(string key, string group, int value, int maxValue)
        {
            this.key = key;
            this.group = group;
            this.value = value;
            this.maxValue = maxValue;
        }

        public string Key => key;
        public string Group => group;
        /// <summary>当前值。setter 为 internal：只允许本程序集内（AttributeList）经 SetValue 修改，
        /// 避免外部直接改值绕过变更通知（NotifyChanged），造成 UI 缓存/变更动作不同步。</summary>
        public int Value { get => value; internal set => this.value = value; }
        public int MaxValue => maxValue;

        /// <summary>显示串：有上限显示「当前/上限」，否则仅当前值。</summary>
        public string DisplayText => maxValue > 0 ? $"{value}/{maxValue}" : value.ToString();
    }
}

