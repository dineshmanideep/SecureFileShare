import React from "react";
import makeBlockie from "ethereum-blockies-base64";

export default function WalletAvatar({ address, size = 32 }) {
  if (!address) return null;
  const src = makeBlockie(address);
  return (
    <img
      src={src}
      alt="wallet avatar"
      style={{ width: size, height: size }}
      className="rounded-full ring-2 ring-white flex-shrink-0"
    />
  );
}
