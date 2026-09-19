using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    [Serializable]
    public sealed class ProjectionCalibrationData
    {
        public int version = 3;
        public int projectorWidth = 1920;
        public int projectorHeight = 1080;
        public int targetDisplay = 1;
        public int boardColumns = 100;
        public int boardRows = 100;

        /// <summary>
        /// How many mats the matrix was measured against. Files written before two-mat
        /// support have no such key and JsonUtility leaves this at 1, which is what they were.
        /// </summary>
        public int boardCount = 1;

        /// <summary>
        /// The dead strip between mats. Informational — the authority is the interaction rect's
        /// shape, which encodes it. Written out so the file is readable by a human with a ruler.
        /// </summary>
        public float seamGapMm;

        public float boardWidthMm = 500f;
        public float boardHeightMm = 500f;
        public bool swapXY;
        public bool flipX;
        public bool flipY;
        public SensorPointMode sensorPointMode = SensorPointMode.CellCenter;
        public ProjectionContentMode contentMode = ProjectionContentMode.FullFrameWithInteractionRegion;
        public Rect interactionRectInGameUv = ProjectionCoordinateMapper.DefaultInteractionRect;
        public float[] projectorToBoard = HomographyUtility.ToArray(
            ProjectionCoordinateMapper.CreateDefaultProjectorToBoardPreviewMatrix());

        /// <summary>
        /// The operator's fine adjustment, already folded into <see cref="projectorToBoard"/>:
        /// how far the picture was moved on the table after solving, in mm, + = right / down.
        /// Kept so the un-shifted solve can be recovered and the shift shown and zeroed.
        /// </summary>
        public Vector2 manualShiftMm;

        /// <summary>
        /// How far beyond the sensing grid the game keeps drawing, in mm on each side per axis.
        /// Layout, not mapping: the viewport and canvas grow by it, the matrix does not.
        /// </summary>
        public Vector2 renderMarginMm;
        public float rmsErrorCells;
        public float maxErrorCells;
        public int sampleCount;
        public string createdUtc = string.Empty;
        public List<CalibrationSample> samples = new List<CalibrationSample>();

        public Matrix4x4 Matrix => HomographyUtility.FromArray(projectorToBoard);
    }

    public static class ProjectionCalibrationStore
    {
        private const string FolderName = "ProjectionAlignment";
        private const string FileName = "calibration_v3.json";

        public static string FilePath => Path.Combine(
            Application.persistentDataPath,
            FolderName,
            FileName);

        public static bool TryLoad(out ProjectionCalibrationData data, out string error)
        {
            data = null;
            error = string.Empty;

            try
            {
                if (!File.Exists(FilePath))
                {
                    return false;
                }

                data = JsonUtility.FromJson<ProjectionCalibrationData>(File.ReadAllText(FilePath));
                if (data == null
                    || data.version != 3
                    || data.projectorToBoard == null
                    || data.projectorToBoard.Length != 9
                    || !ProjectionCoordinateMapper.IsValidInteractionRect(data.interactionRectInGameUv))
                {
                    error = "校准文件格式无效。";
                    data = null;
                    return false;
                }

                if (!HomographyUtility.TryInvert(data.Matrix, out _))
                {
                    error = "校准文件中的矩阵不可逆。";
                    data = null;
                    return false;
                }

                return true;
            }
            catch (Exception exception)
            {
                error = exception.Message;
                data = null;
                return false;
            }
        }

        public static bool TrySave(ProjectionCalibrationData data, out string error)
        {
            error = string.Empty;
            try
            {
                string folder = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrEmpty(folder))
                {
                    Directory.CreateDirectory(folder);
                }

                string temporaryPath = FilePath + ".tmp";
                File.WriteAllText(temporaryPath, JsonUtility.ToJson(data, true));
                File.Copy(temporaryPath, FilePath, true);
                File.Delete(temporaryPath);
                return true;
            }
            catch (Exception exception)
            {
                error = exception.Message;
                return false;
            }
        }

        public static void Delete()
        {
            if (File.Exists(FilePath))
            {
                File.Delete(FilePath);
            }
        }
    }
}
