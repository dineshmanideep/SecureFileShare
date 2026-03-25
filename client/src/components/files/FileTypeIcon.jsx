import React from "react";
import {
  FileText, Image, Film, Music, Archive, Code, Table, FileSpreadsheet,
  Presentation, FileQuestion
} from "lucide-react";

const EXT_MAP = {
  pdf:  { icon: FileText,        color: "text-red-500",    bg: "bg-red-50"    },
  doc:  { icon: FileText,        color: "text-blue-600",   bg: "bg-blue-50"   },
  docx: { icon: FileText,        color: "text-blue-600",   bg: "bg-blue-50"   },
  xls:  { icon: FileSpreadsheet, color: "text-green-600",  bg: "bg-green-50"  },
  xlsx: { icon: FileSpreadsheet, color: "text-green-600",  bg: "bg-green-50"  },
  csv:  { icon: Table,           color: "text-green-500",  bg: "bg-green-50"  },
  ppt:  { icon: Presentation,    color: "text-orange-500", bg: "bg-orange-50" },
  pptx: { icon: Presentation,    color: "text-orange-500", bg: "bg-orange-50" },
  txt:  { icon: FileText,        color: "text-gray-500",   bg: "bg-gray-50"   },
  md:   { icon: FileText,        color: "text-gray-500",   bg: "bg-gray-50"   },
  jpg:  { icon: Image,           color: "text-pink-500",   bg: "bg-pink-50"   },
  jpeg: { icon: Image,           color: "text-pink-500",   bg: "bg-pink-50"   },
  png:  { icon: Image,           color: "text-pink-500",   bg: "bg-pink-50"   },
  gif:  { icon: Image,           color: "text-pink-500",   bg: "bg-pink-50"   },
  svg:  { icon: Image,           color: "text-purple-500", bg: "bg-purple-50" },
  webp: { icon: Image,           color: "text-pink-500",   bg: "bg-pink-50"   },
  mp4:  { icon: Film,            color: "text-violet-500", bg: "bg-violet-50" },
  mov:  { icon: Film,            color: "text-violet-500", bg: "bg-violet-50" },
  avi:  { icon: Film,            color: "text-violet-500", bg: "bg-violet-50" },
  mp3:  { icon: Music,           color: "text-indigo-500", bg: "bg-indigo-50" },
  wav:  { icon: Music,           color: "text-indigo-500", bg: "bg-indigo-50" },
  zip:  { icon: Archive,         color: "text-amber-600",  bg: "bg-amber-50"  },
  rar:  { icon: Archive,         color: "text-amber-600",  bg: "bg-amber-50"  },
  tar:  { icon: Archive,         color: "text-amber-600",  bg: "bg-amber-50"  },
  js:   { icon: Code,            color: "text-yellow-500", bg: "bg-yellow-50" },
  ts:   { icon: Code,            color: "text-blue-500",   bg: "bg-blue-50"   },
  py:   { icon: Code,            color: "text-teal-500",   bg: "bg-teal-50"   },
  json: { icon: Code,            color: "text-gray-600",   bg: "bg-gray-100"  },
};

export default function FileTypeIcon({ fileName, size = 20, containerSize = 40 }) {
  const ext = (fileName || "").split(".").pop().toLowerCase();
  const config = EXT_MAP[ext] || { icon: FileQuestion, color: "text-gray-400", bg: "bg-gray-100" };
  const Icon = config.icon;
  return (
    <div
      className={`flex items-center justify-center rounded-xl flex-shrink-0 ${config.bg}`}
      style={{ width: containerSize, height: containerSize }}
    >
      <Icon style={{ width: size, height: size }} className={config.color} />
    </div>
  );
}
