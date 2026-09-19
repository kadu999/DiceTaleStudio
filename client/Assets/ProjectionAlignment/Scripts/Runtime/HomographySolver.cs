using System;
using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    public readonly struct HomographySolveResult
    {
        public readonly bool success;
        public readonly Matrix4x4 projectorToBoard;
        public readonly Matrix4x4 boardToProjector;
        public readonly float rmsError;
        public readonly float maxError;
        public readonly string error;

        public HomographySolveResult(
            bool success,
            Matrix4x4 projectorToBoard,
            Matrix4x4 boardToProjector,
            float rmsError,
            float maxError,
            string error)
        {
            this.success = success;
            this.projectorToBoard = projectorToBoard;
            this.boardToProjector = boardToProjector;
            this.rmsError = rmsError;
            this.maxError = maxError;
            this.error = error;
        }

        public static HomographySolveResult Failure(string message)
        {
            return new HomographySolveResult(
                false,
                Matrix4x4.identity,
                Matrix4x4.identity,
                float.PositiveInfinity,
                float.PositiveInfinity,
                message);
        }
    }

    public static class HomographySolver
    {
        private const int UnknownCount = 8;
        private const double PivotEpsilon = 1e-12;

        public static HomographySolveResult Solve(IReadOnlyList<CalibrationSample> samples)
        {
            if (samples == null || samples.Count < 4)
            {
                return HomographySolveResult.Failure("至少需要四个标定点。");
            }

            if (!HasTwoDimensionalCoverage(samples, true) || !HasTwoDimensionalCoverage(samples, false))
            {
                return HomographySolveResult.Failure("标定点覆盖面积过小或接近共线。");
            }

            var normal = new double[UnknownCount, UnknownCount];
            var rhs = new double[UnknownCount];

            for (int index = 0; index < samples.Count; index++)
            {
                CalibrationSample sample = samples[index];
                double x = sample.projectorUv.x;
                double y = sample.projectorUv.y;
                double u = sample.boardUv.x;
                double v = sample.boardUv.y;
                double weight = Math.Sqrt(Math.Max(0.01, sample.confidence));

                double[] rowU = { x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y };
                double[] rowV = { 0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y };
                AccumulateNormalEquation(normal, rhs, rowU, u, weight);
                AccumulateNormalEquation(normal, rhs, rowV, v, weight);
            }

            if (!TrySolveLinearSystem(normal, rhs, out double[] h))
            {
                return HomographySolveResult.Failure("单应矩阵方程退化，无法求解。");
            }

            Matrix4x4 projectorToBoard = HomographyUtility.FromCoefficients(
                h[0], h[1], h[2],
                h[3], h[4], h[5],
                h[6], h[7], 1.0);

            if (!HomographyUtility.IsFinite(projectorToBoard)
                || !HomographyUtility.TryInvert(projectorToBoard, out Matrix4x4 boardToProjector))
            {
                return HomographySolveResult.Failure("求得的单应矩阵不可逆。");
            }

            double squaredError = 0.0;
            float maxError = 0f;
            for (int index = 0; index < samples.Count; index++)
            {
                if (!HomographyUtility.TryApply(projectorToBoard, samples[index].projectorUv, out Vector2 predicted))
                {
                    return HomographySolveResult.Failure("单应矩阵在有效区域内出现无效齐次坐标。");
                }

                float error = Vector2.Distance(predicted, samples[index].boardUv);
                squaredError += error * error;
                maxError = Mathf.Max(maxError, error);
            }

            float rmsError = Mathf.Sqrt((float)(squaredError / samples.Count));
            return new HomographySolveResult(
                true,
                projectorToBoard,
                boardToProjector,
                rmsError,
                maxError,
                string.Empty);
        }

        private static void AccumulateNormalEquation(
            double[,] normal,
            double[] rhs,
            double[] row,
            double target,
            double weight)
        {
            for (int i = 0; i < UnknownCount; i++)
            {
                double weightedI = row[i] * weight;
                rhs[i] += weightedI * target * weight;
                for (int j = 0; j < UnknownCount; j++)
                {
                    normal[i, j] += weightedI * row[j] * weight;
                }
            }
        }

        private static bool TrySolveLinearSystem(double[,] matrix, double[] rhs, out double[] result)
        {
            int size = rhs.Length;
            var augmented = new double[size, size + 1];
            for (int row = 0; row < size; row++)
            {
                for (int column = 0; column < size; column++)
                {
                    augmented[row, column] = matrix[row, column];
                }

                augmented[row, size] = rhs[row];
            }

            for (int pivot = 0; pivot < size; pivot++)
            {
                int bestRow = pivot;
                double bestValue = Math.Abs(augmented[pivot, pivot]);
                for (int row = pivot + 1; row < size; row++)
                {
                    double candidate = Math.Abs(augmented[row, pivot]);
                    if (candidate > bestValue)
                    {
                        bestValue = candidate;
                        bestRow = row;
                    }
                }

                if (bestValue < PivotEpsilon)
                {
                    result = null;
                    return false;
                }

                if (bestRow != pivot)
                {
                    for (int column = pivot; column <= size; column++)
                    {
                        (augmented[pivot, column], augmented[bestRow, column]) =
                            (augmented[bestRow, column], augmented[pivot, column]);
                    }
                }

                double divisor = augmented[pivot, pivot];
                for (int column = pivot; column <= size; column++)
                {
                    augmented[pivot, column] /= divisor;
                }

                for (int row = 0; row < size; row++)
                {
                    if (row == pivot)
                    {
                        continue;
                    }

                    double factor = augmented[row, pivot];
                    if (Math.Abs(factor) < PivotEpsilon)
                    {
                        continue;
                    }

                    for (int column = pivot; column <= size; column++)
                    {
                        augmented[row, column] -= factor * augmented[pivot, column];
                    }
                }
            }

            result = new double[size];
            for (int row = 0; row < size; row++)
            {
                result[row] = augmented[row, size];
                if (double.IsNaN(result[row]) || double.IsInfinity(result[row]))
                {
                    result = null;
                    return false;
                }
            }

            return true;
        }

        private static bool HasTwoDimensionalCoverage(IReadOnlyList<CalibrationSample> samples, bool projector)
        {
            float largestDoubleArea = 0f;
            for (int a = 0; a < samples.Count - 2; a++)
            {
                Vector2 pa = projector ? samples[a].projectorUv : samples[a].boardUv;
                for (int b = a + 1; b < samples.Count - 1; b++)
                {
                    Vector2 pb = projector ? samples[b].projectorUv : samples[b].boardUv;
                    for (int c = b + 1; c < samples.Count; c++)
                    {
                        Vector2 pc = projector ? samples[c].projectorUv : samples[c].boardUv;
                        float doubleArea = Mathf.Abs(
                            (pb.x - pa.x) * (pc.y - pa.y)
                            - (pb.y - pa.y) * (pc.x - pa.x));
                        largestDoubleArea = Mathf.Max(largestDoubleArea, doubleArea);
                    }
                }
            }

            return largestDoubleArea > 1e-4f;
        }
    }
}
