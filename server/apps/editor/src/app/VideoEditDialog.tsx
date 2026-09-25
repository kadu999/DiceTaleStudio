import { videoDataOf } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { assetDisplayName } from "../panels/asset-info";
import { assetDisplayPath, findAssetByReference, listVideoAssets } from "../panels/asset-picker";
import {
  fileNameOf,
  MediaClipListDialog,
  type MediaClipLabels,
} from "./MediaClipListDialog";

/**
 * 「编辑视频」窗口：给这个地图 / 贴图**加 / 删视频**，并给每个文件起个显示名。
 * 窗口结构 / 交互与「编辑声音」完全同一套（`MediaClipListDialog`），
 * 这里只装视频自己的文案、store 动作与行展示细节（webm 提醒徽标）。
 */

const LABELS: MediaClipLabels = {
  noun: "视频",
  gone: "这个对象已经不在了",
  media: "视频",
  scope: "这个对象",
  footerHint: "放哪条在属性面板上点小方块选；这里只管加 / 删 / 起名字（留空 = 用文件名）。",
  nameTitle: "给这个视频文件起个好认的名字（留空 = 用文件名）",
};

interface VideoEditDialogProps {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function VideoEditDialog({ open, objectId, onClose }: VideoEditDialogProps): React.JSX.Element {
  const setVideoClipName = useEditorStore((state) => state.setVideoClipName);
  const addVideoClip = useEditorStore((state) => state.addVideoClip);
  const removeVideoClip = useEditorStore((state) => state.removeVideoClip);

  return (
    <MediaClipListDialog
      open={open}
      objectId={objectId}
      onClose={onClose}
      prefix="video"
      labels={LABELS}
      dataOf={videoDataOf}
      listAssets={listVideoAssets}
      pickerKind="video"
      buildRow={(id, { tree, assetMetas, assetIds }) => {
        const asset = findAssetByReference(tree, id, assetMetas);
        const currentId = asset?.id ?? id;
        const formatHint = id.toLowerCase().endsWith(".webm")
          ? "WebM：Windows 上多半解不了，建议改用 H.264 的 .mp4"
          : undefined;
        return {
          id,
          fileName: assetDisplayName(asset?.name ?? fileNameOf(currentId)),
          placeholder: assetDisplayName(asset?.name ?? fileNameOf(currentId)),
          path: assetDisplayPath(currentId),
          pathTitle: [id, formatHint].filter((line) => line !== undefined).join("\n"),
          missing: asset === undefined || !assetIds.has(asset.id),
          badge:
            formatHint === undefined
              ? undefined
              : { label: "webm?", title: formatHint, testid: "video-edit-warning" },
        };
      }}
      onAdd={(object, clip) => addVideoClip(object, clip)}
      onRename={(object, clip, name) => setVideoClipName(object, clip, name)}
      onRemove={(object, clip) => removeVideoClip(object, clip)}
    />
  );
}
