import { soundDataOf } from "@dts/document";
import { useEditorStore } from "../state/editor-store";
import { audioNameOf } from "../panels/audio-catalog";
import { assetDisplayName } from "../panels/asset-info";
import { assetDisplayPath, findAssetByReference, listAudioAssets } from "../panels/asset-picker";
import { AudioPickerDialog } from "./AudioPickerDialog";
import {
  fileNameOf,
  MediaClipListDialog,
  type MediaClipLabels,
} from "./MediaClipListDialog";

/**
 * 「编辑声音」窗口：给这条声音对象**加 / 删音频**，并给每个文件起个显示名。
 * 窗口结构 / 交互与「编辑视频」完全同一套（`MediaClipListDialog`），
 * 这里只装声音自己的文案、store 动作与行展示细节。
 */

const LABELS: MediaClipLabels = {
  noun: "声音",
  gone: "这个声音对象已经不在了",
  media: "音频",
  scope: "这条声音对象",
  footerHint: "播哪条在属性面板上点小方块选；这里只管加 / 删 / 起名字（留空 = 用文件名）。",
  nameTitle: "只给这一条声音对象改名（覆盖）；留空 = 跟随音频文件自己的名字（在「音频文件」窗口里改）",
};

interface SoundEditDialogProps {
  readonly open: boolean;
  readonly objectId: string | null;
  readonly onClose: () => void;
}

export function SoundEditDialog({ open, objectId, onClose }: SoundEditDialogProps): React.JSX.Element {
  const setSoundClipName = useEditorStore((state) => state.setSoundClipName);
  const addSoundClip = useEditorStore((state) => state.addSoundClip);
  const removeSoundClip = useEditorStore((state) => state.removeSoundClip);

  return (
    <MediaClipListDialog
      open={open}
      objectId={objectId}
      onClose={onClose}
      prefix="sound"
      labels={LABELS}
      dataOf={soundDataOf}
      listAssets={listAudioAssets}
      picker={AudioPickerDialog}
      buildRow={(id, { tree, assetMetas, metaTable, assetIds }) => {
        const asset = findAssetByReference(tree, id, assetMetas);
        const currentId = asset?.id ?? id;
        return {
          id,
          fileName: assetDisplayName(asset?.name ?? fileNameOf(currentId)),
          // 输入框的占位 = **跟随的那一层**（音频文件自己的名字，没有才用文件名）：
          // 留空时这一条会显示成它，作者一眼看得出「不改就是这个名字」
          placeholder:
            audioNameOf(metaTable, currentId) ?? assetDisplayName(asset?.name ?? fileNameOf(currentId)),
          path: assetDisplayPath(currentId),
          pathTitle: id,
          missing: asset === undefined || !assetIds.has(asset.id),
          badge: undefined,
        };
      }}
      onAdd={(object, clip) => addSoundClip(object, clip)}
      onRename={(object, clip, name) => setSoundClipName(object, clip, name)}
      onRemove={(object, clip) => removeSoundClip(object, clip)}
    />
  );
}
