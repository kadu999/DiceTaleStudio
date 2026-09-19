namespace DiceTale.Editor
{
    public static class GridMapEditorConstants
    {
        public const float CellDisplaySize = 24f;
        // .bytes 网格数据与场景/地图 prefab 统一放在 Resources/Scenes/ 子目录（运行时 LoadData 从该子目录读取）
        public const string DataDirectory = "Assets/DiceTale/Resources/Scenes";
        public const string DataDirectoryFull = "DiceTale/Resources/Scenes";
        public const int MinBrushSize = 1;
        public const int MaxBrushSize = 5;
    }
}
