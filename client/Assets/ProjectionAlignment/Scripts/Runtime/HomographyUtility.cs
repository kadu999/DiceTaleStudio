using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    public static class HomographyUtility
    {
        private const float Epsilon = 1e-7f;

        public static Matrix4x4 FromCoefficients(
            double h00, double h01, double h02,
            double h10, double h11, double h12,
            double h20, double h21, double h22)
        {
            var matrix = Matrix4x4.zero;
            matrix.m00 = (float)h00;
            matrix.m01 = (float)h01;
            matrix.m02 = (float)h02;
            matrix.m10 = (float)h10;
            matrix.m11 = (float)h11;
            matrix.m12 = (float)h12;
            matrix.m20 = (float)h20;
            matrix.m21 = (float)h21;
            matrix.m22 = (float)h22;
            matrix.m33 = 1f;
            return matrix;
        }

        public static bool TryApply(Matrix4x4 matrix, Vector2 point, out Vector2 result)
        {
            float x = matrix.m00 * point.x + matrix.m01 * point.y + matrix.m02;
            float y = matrix.m10 * point.x + matrix.m11 * point.y + matrix.m12;
            float w = matrix.m20 * point.x + matrix.m21 * point.y + matrix.m22;

            if (!IsFinite(x) || !IsFinite(y) || !IsFinite(w) || Mathf.Abs(w) < Epsilon)
            {
                result = default;
                return false;
            }

            result = new Vector2(x / w, y / w);
            return IsFinite(result.x) && IsFinite(result.y);
        }

        public static bool TryInvert(Matrix4x4 matrix, out Matrix4x4 inverse)
        {
            double a = matrix.m00;
            double b = matrix.m01;
            double c = matrix.m02;
            double d = matrix.m10;
            double e = matrix.m11;
            double f = matrix.m12;
            double g = matrix.m20;
            double h = matrix.m21;
            double i = matrix.m22;

            double determinant = a * (e * i - f * h)
                               - b * (d * i - f * g)
                               + c * (d * h - e * g);

            if (double.IsNaN(determinant) || double.IsInfinity(determinant) || System.Math.Abs(determinant) < 1e-10)
            {
                inverse = Matrix4x4.identity;
                return false;
            }

            double inv = 1.0 / determinant;
            inverse = FromCoefficients(
                (e * i - f * h) * inv,
                (c * h - b * i) * inv,
                (b * f - c * e) * inv,
                (f * g - d * i) * inv,
                (a * i - c * g) * inv,
                (c * d - a * f) * inv,
                (d * h - e * g) * inv,
                (b * g - a * h) * inv,
                (a * e - b * d) * inv);
            return IsFinite(inverse);
        }

        /// <summary>
        /// The same mapping with its board-space output moved by <paramref name="deltaBoardUv"/>:
        /// T(delta) · H. Adding delta times the w row to the x and y rows is the translation,
        /// because the shader divides both by that same w.
        /// </summary>
        public static Matrix4x4 Translate(Matrix4x4 projectorToBoard, Vector2 deltaBoardUv)
        {
            Matrix4x4 shifted = projectorToBoard;
            shifted.m00 += deltaBoardUv.x * projectorToBoard.m20;
            shifted.m01 += deltaBoardUv.x * projectorToBoard.m21;
            shifted.m02 += deltaBoardUv.x * projectorToBoard.m22;
            shifted.m10 += deltaBoardUv.y * projectorToBoard.m20;
            shifted.m11 += deltaBoardUv.y * projectorToBoard.m21;
            shifted.m12 += deltaBoardUv.y * projectorToBoard.m22;
            return shifted;
        }

        public static bool IsFinite(Matrix4x4 matrix)
        {
            for (int row = 0; row < 4; row++)
            {
                for (int column = 0; column < 4; column++)
                {
                    if (!IsFinite(matrix[row, column]))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        public static float[] ToArray(Matrix4x4 matrix)
        {
            return new[]
            {
                matrix.m00, matrix.m01, matrix.m02,
                matrix.m10, matrix.m11, matrix.m12,
                matrix.m20, matrix.m21, matrix.m22
            };
        }

        public static Matrix4x4 FromArray(float[] values)
        {
            if (values == null || values.Length != 9)
            {
                return Matrix4x4.identity;
            }

            return FromCoefficients(
                values[0], values[1], values[2],
                values[3], values[4], values[5],
                values[6], values[7], values[8]);
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }
    }
}
