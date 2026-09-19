using NUnit.Framework;
using UnityEngine;

namespace NuLight.ProjectionAlignment.Tests
{
    public sealed class ContactRefinementTests
    {
        private const int Rows = 20;
        private const int Columns = 30;

        private static int[] Frame(System.Func<int, int, int> value)
        {
            var frame = new int[Rows * Columns];
            for (int row = 0; row < Rows; row++)
            {
                for (int column = 0; column < Columns; column++)
                {
                    frame[row * Columns + column] = value(row, column);
                }
            }

            return frame;
        }

        private static int Blob(int row, int column, float centreRow, float centreColumn, float sigma = 1.2f, int peak = 100)
        {
            float distance = (row - centreRow) * (row - centreRow) + (column - centreColumn) * (column - centreColumn);
            return Mathf.RoundToInt(peak * Mathf.Exp(-distance / (2f * sigma * sigma)));
        }

        [Test]
        public void Refine_BlobOnACellCentre_ReturnsThatCell()
        {
            int[] frame = Frame((r, c) => Blob(r, c, 10f, 15f));

            Vector2 refined = ContactRefinement.Refine(frame, Rows, Columns, 10, 15);

            Assert.That(refined.x, Is.EqualTo(10f).Within(1e-3f));
            Assert.That(refined.y, Is.EqualTo(15f).Within(1e-3f));
        }

        [Test]
        public void Refine_BlobBetweenCells_RecoversTheFraction()
        {
            int[] frame = Frame((r, c) => Blob(r, c, 10.4f, 14.7f));

            Vector2 refined = ContactRefinement.Refine(frame, Rows, Columns, 10, 15);

            Assert.That(refined.x, Is.EqualTo(10.4f).Within(0.1f));
            Assert.That(refined.y, Is.EqualTo(14.7f).Within(0.1f));
        }

        [Test]
        public void Refine_OnTheFrameBorder_IsNotDraggedInward()
        {
            // Half the blob is off the sensor. The window shrinks to the rows that exist on
            // both sides of the peak — here none — so the border row stays the border row.
            int[] frame = Frame((r, c) => Blob(r, c, 0f, 15f));

            Vector2 refined = ContactRefinement.Refine(frame, Rows, Columns, 0, 15);

            Assert.That(refined.x, Is.EqualTo(0f).Within(1e-3f));
            Assert.That(refined.y, Is.EqualTo(15f).Within(1e-3f));
        }

        [Test]
        public void Refine_NeighbouringContact_DoesNotPullTheCentroid()
        {
            int[] frame = Frame((r, c) => Blob(r, c, 10f, 10f) + Blob(r, c, 10f, 16f, peak: 60));

            Vector2 refined = ContactRefinement.Refine(frame, Rows, Columns, 10, 10);

            Assert.That(refined.x, Is.EqualTo(10f).Within(0.05f));
            Assert.That(refined.y, Is.EqualTo(10f).Within(0.05f));
        }

        [Test]
        public void Refine_StaysWithinOneCellOfThePeak()
        {
            // A lopsided plateau: the centroid of the window is well off the peak, and that is
            // further than any real contact moves between the smoothed peak and its raw cells.
            int[] frame = Frame((r, c) => r == 10 && c >= 15 && c <= 17 ? 100 : 0);

            Vector2 refined = ContactRefinement.Refine(frame, Rows, Columns, 10, 15);

            Assert.That(refined.y, Is.EqualTo(16f).Within(1e-3f));
        }

        [Test]
        public void Refine_MissingOrEmptyFrame_ReturnsThePeak()
        {
            Vector2 fromNull = ContactRefinement.Refine(null, Rows, Columns, 3, 4);
            Vector2 fromEmpty = ContactRefinement.Refine(new int[Rows * Columns], Rows, Columns, 3, 4);

            Assert.That(fromNull, Is.EqualTo(new Vector2(3f, 4f)));
            Assert.That(fromEmpty, Is.EqualTo(new Vector2(3f, 4f)));
        }
    }
}
