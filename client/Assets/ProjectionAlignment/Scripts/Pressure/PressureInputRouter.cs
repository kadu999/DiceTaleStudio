using System.Collections.Generic;
using UnityEngine;

namespace NuLight.ProjectionAlignment
{
    [DisallowMultipleComponent]
    [DefaultExecutionOrder(-60)]
    public sealed class PressureInputRouter : MonoBehaviour
    {
        [Header("Sources")]
        [SerializeField] private DevicePipePressureSource hardwareSource;
        [SerializeField] private MousePressureSource simulationSource;
        [SerializeField] private bool useSimulationWhenDisconnected = true;

        [Header("Board Orientation")]
        [Tooltip("Applies to every source. Use this when the mat itself is physically rotated. "
            + "The DevicePipe row/column convention is handled on DevicePipePressureSource instead.")]
        [SerializeField] private SensorPointMode pointMode = SensorPointMode.CellCenter;
        [SerializeField] private bool swapXY;
        [SerializeField] private bool flipX;
        [SerializeField] private bool flipY;

        [Header("Seam")]
        [Tooltip("How far either side of the seam a contact has to be to count as a seam contact, "
            + "in cm. Only contacts this close to the dead strip are candidates for merging.")]
        [SerializeField, Min(0f)] private float seamMergeReachCm = 2.5f;

        [Tooltip("How far apart two half-prints may be and still be one fingertip, in cm. A "
            + "fingertip is about 2 cm across, so once the dead strip has eaten the middle its "
            + "two halves land a little over a centimetre apart. This is the ceiling on how "
            + "close two REAL contacts may be before the rig mistakes them for one, so it has to "
            + "stay under the tightest spacing any game asks two fingers to hold at once.")]
        [SerializeField, Min(0.1f)] private float seamMergeSpanCm = 3.4f;

        [Header("Pressure Scale")]
        [Tooltip("Raw pressure value that counts as full scale. The interface doc says 0..255 but "
            + "that describes a wrapper API this project does not use; DeviceViz's own layer assumes "
            + "~100, and the real range is the firmware's smoothed sample peak. Confirm on hardware "
            + "using the highest value reported on the debug overlay.")]
        [SerializeField, Min(1f)] private float pressureFullScale = 100f;

        private readonly List<BoardContact> contacts = new List<BoardContact>(16);

        public IReadOnlyList<BoardContact> Contacts => contacts;
        public Vector2Int SensorResolution { get; private set; } = new Vector2Int(100, 100);

        /// <summary>
        /// How many mats the interactive area is made of. Latched to the hardware once any
        /// mat has been seen: falling back to the mouse simulator during a dropout must not
        /// resize the area, because the area's shape is what the calibration was measured on.
        /// </summary>
        public int BoardCount { get; private set; } = 1;
        public int ConnectedBoardCount => hardwareSource != null ? hardwareSource.ConnectedBoardCount : 0;
        public bool HasConnectedHardware => ConnectedBoardCount > 0;

        /// <summary>The interactive area's physical width / height, from the mat count.</summary>
        public float MatAspect => ProjectionCoordinateMapper.MatAspectFor(BoardCount);

        /// <summary>
        /// Sensor resolution in board-axis order — how many cells board UV spans horizontally
        /// and vertically. <see cref="SensorResolution"/> is in raw sensor order, which is
        /// transposed from board UV whenever <see cref="SwapXY"/> is on. Anything converting a
        /// board-UV distance into cells has to use this, and per axis: with two mats the two
        /// axes have different cell counts, so a single scalar scale is wrong by 2x on one of them.
        /// </summary>
        public Vector2Int BoardResolution => swapXY
            ? new Vector2Int(SensorResolution.y, SensorResolution.x)
            : SensorResolution;

        /// <summary>The dead strip between mats, in cm. Zero on a single-mat rig.</summary>
        public float SeamGapCm => hardwareSource != null && BoardCount > 1 ? hardwareSource.SeamGapCm : 0f;

        /// <summary>The interactive area's physical width in cm, seams included.</summary>
        public float AreaWidthCm => ProjectionCoordinateMapper.AreaWidthCm(BoardCount, SeamGapCm);

        /// <summary>How many contacts the last frame merged across a seam — one finger read as two.</summary>
        public int SeamMergeCount { get; private set; }

        public void SetSeamGapCm(float centimetres)
        {
            if (hardwareSource != null)
            {
                hardwareSource.SetSeamGapCm(centimetres);
            }
        }

        public string ActiveSourceName { get; private set; } = "None";
        public bool UsingSimulation { get; private set; }
        public SensorPointMode PointMode => pointMode;
        public bool SwapXY => swapXY;
        public bool FlipX => flipX;
        public bool FlipY => flipY;
        public float PressureFullScale => pressureFullScale;
        public DevicePipePressureSource HardwareSource => hardwareSource;
        public MousePressureSource SimulationSource => simulationSource;

        /// <summary>Highest raw pressure the hardware has reported since start, for scale calibration.</summary>
        public float HighestPressureSeen => hardwareSource != null ? hardwareSource.HighestPressureSeen : 0f;

        public void Configure(DevicePipePressureSource hardware, MousePressureSource simulator)
        {
            hardwareSource = hardware;
            simulationSource = simulator;
        }

        private void Update()
        {
            UsingSimulation = false;
            IPressureBoardSource source = null;
            if (hardwareSource != null && hardwareSource.IsReady)
            {
                source = hardwareSource;
                UsingSimulation = false;
            }
            else if (useSimulationWhenDisconnected && simulationSource != null && simulationSource.IsReady)
            {
                source = simulationSource;
                UsingSimulation = true;
            }

            if (hardwareSource != null)
            {
                // Which sensor axis the mats are tiled along is the same question as which
                // sensor axis ends up horizontal in board UV, so it is not an independent
                // setting — it follows the orientation flags. Board x reads the column index
                // when exactly one of the two swaps is on; when both or neither are on it
                // reads the row index, and the pair has to be tiled along rows to match.
                hardwareSource.SetTileAlongRows(hardwareSource.SwapRowColumn == swapXY);
            }

            if (hardwareSource != null && hardwareSource.HasBoards)
            {
                BoardCount = hardwareSource.BoardCount;
            }
            else if (hardwareSource == null && source != null)
            {
                BoardCount = source.BoardCount;
            }

            contacts.Clear();
            if (source == null)
            {
                ActiveSourceName = "None";
                return;
            }

            ActiveSourceName = source.SourceName;
            SensorResolution = source.SensorResolution;
            IReadOnlyList<PressureContact> rawContacts = source.Contacts;
            for (int index = 0; index < rawContacts.Count; index++)
            {
                PressureContact rawContact = rawContacts[index];
                Vector2 boardUv = ProjectionCoordinateMapper.RawToBoardUv(
                    rawContact.rawPosition,
                    SensorResolution,
                    pointMode,
                    swapXY,
                    flipX,
                    flipY);
                contacts.Add(new BoardContact(
                    boardUv,
                    rawContact,
                    rawContact.pressure / Mathf.Max(1f, pressureFullScale)));
            }

            MergeContactsAcrossSeam();
        }

        /// <summary>
        /// Rejoins one fingertip that the seam split in two.
        ///
        /// <para>
        /// The dead strip carries no sensor, so a finger pressed on it leaves half a print on
        /// each mat. The blob analyser sees two peaks with dead cells between them and cannot
        /// merge them — its own merge distance is five cells, and the strip alone is wider than
        /// that. The consequences are worse than a cosmetic double dot: calibration only
        /// captures when exactly one contact is present, so it silently stops advancing, and
        /// the game gets two touches where a player made one.
        /// </para>
        ///
        /// <para>
        /// The thresholds used to be 6 cm and 14 cm, sized for a <i>foot</i> — which was a
        /// misreading of the hardware that stood for a long time. This mat lies on a table and
        /// is pressed with hands; nothing has ever stood on it. Sized for a foot the merge is
        /// not merely loose, it is wrong in a way that only shows up once a game puts two
        /// fingers down at once near the middle of the table: on a piano drawn across both
        /// mats, D5 and G5 are 11.7 cm apart with both inside 6 cm of the seam, so a plain
        /// fourth would be answered as a single contact halfway between the two keys. That
        /// looks like the mat dropping notes, not like a threshold.
        /// </para>
        ///
        /// <para>
        /// So the span is the load-bearing number and it is a <i>ceiling</i>, not a margin: it
        /// has to stay under the tightest spacing any game asks two fingers to hold at once,
        /// which is currently the piano's 3.90 cm white key pitch. 3.4 cm clears that and still
        /// rejoins anything up to a few centimetres wide straddling the strip — a fingertip at
        /// about 2 cm, a game piece's 2.5 cm base. The one case no threshold can separate is two
        /// fingers a semitone apart astride the strip: at 3.9 cm they are geometrically
        /// indistinguishable from one wider object on it.
        /// </para>
        ///
        /// Only contacts on opposite sides of a seam, both near it, and within that span of each
        /// other are joined.
        /// </summary>
        private void MergeContactsAcrossSeam()
        {
            SeamMergeCount = 0;
            if (BoardCount < 2 || contacts.Count < 2)
            {
                return;
            }

            float widthCm = AreaWidthCm;
            float heightCm = ProjectionCoordinateMapper.MatEdgeCm;

            for (int a = 0; a < contacts.Count - 1; a++)
            {
                for (int b = a + 1; b < contacts.Count; b++)
                {
                    BoardContact first = contacts[a];
                    BoardContact second = contacts[b];
                    if (first.boardIndex == second.boardIndex)
                    {
                        continue;
                    }

                    int seam = Mathf.Min(first.boardIndex, second.boardIndex);
                    Vector2 span = ProjectionCoordinateMapper.SeamSpanInBoardUv(seam, BoardCount, SeamGapCm);
                    float seamCentre = (span.x + span.y) * 0.5f * widthCm;
                    if (Mathf.Abs(first.boardUv.x * widthCm - seamCentre) > seamMergeReachCm
                        || Mathf.Abs(second.boardUv.x * widthCm - seamCentre) > seamMergeReachCm)
                    {
                        continue;
                    }

                    Vector2 separation = new Vector2(
                        (first.boardUv.x - second.boardUv.x) * widthCm,
                        (first.boardUv.y - second.boardUv.y) * heightCm);
                    if (separation.magnitude > seamMergeSpanCm)
                    {
                        continue;
                    }

                    contacts[a] = MergeContacts(first, second);
                    contacts.RemoveAt(b);
                    SeamMergeCount++;
                    b--;
                }
            }
        }

        /// <summary>
        /// Joins two half-prints into the finger they came from. The centroid is weighted by
        /// pressure and the pressures add: each half only carries part of the load, and a sum
        /// is what the whole fingertip would have registered had the strip been live.
        /// </summary>
        private BoardContact MergeContacts(BoardContact first, BoardContact second)
        {
            float firstWeight = Mathf.Max(0.0001f, first.pressure);
            float secondWeight = Mathf.Max(0.0001f, second.pressure);
            float total = firstWeight + secondWeight;
            Vector2 boardUv = (first.boardUv * firstWeight + second.boardUv * secondWeight) / total;
            Vector2 raw = (first.rawPosition * firstWeight + second.rawPosition * secondWeight) / total;
            float pressure = first.pressure + second.pressure;

            var source = new PressureContact(
                raw,
                Mathf.Max(first.radius, second.radius),
                pressure,
                firstWeight >= secondWeight ? first.boardIndex : second.boardIndex);
            return new BoardContact(boardUv, source, pressure / Mathf.Max(1f, pressureFullScale));
        }

        public void SetOrientation(bool newSwapXY, bool newFlipX, bool newFlipY)
        {
            swapXY = newSwapXY;
            flipX = newFlipX;
            flipY = newFlipY;
        }

        public void ToggleSwapXY()
        {
            swapXY = !swapXY;
        }

        public void ToggleFlipX()
        {
            flipX = !flipX;
        }

        public void ToggleFlipY()
        {
            flipY = !flipY;
        }

        public void ToggleHardwareRowColumnSwap()
        {
            if (hardwareSource != null)
            {
                hardwareSource.SetSwapRowColumn(!hardwareSource.SwapRowColumn);
            }
        }

        /// <summary>
        /// Swaps which physical mat counts as the left one. The serial ports enumerate in an
        /// order that has nothing to do with how the mats were laid out, so this is a coin
        /// flip until someone steps on the left mat — which is what calibration does.
        /// </summary>
        public void ToggleBoardSwap()
        {
            if (hardwareSource != null)
            {
                hardwareSource.SetSwapBoards(!hardwareSource.SwapBoards);
            }
        }

        public bool BoardsSwapped => hardwareSource != null && hardwareSource.SwapBoards;

        public void SetPressureFullScale(float value)
        {
            pressureFullScale = Mathf.Max(1f, value);
        }

        /// <summary>Adopts the highest pressure seen so far as full scale, then restarts tracking.</summary>
        public void AdoptHighestPressureAsFullScale()
        {
            if (hardwareSource == null || hardwareSource.HighestPressureSeen < 1f)
            {
                return;
            }

            pressureFullScale = hardwareSource.HighestPressureSeen;
            hardwareSource.ResetHighestPressureSeen();
        }
    }
}
