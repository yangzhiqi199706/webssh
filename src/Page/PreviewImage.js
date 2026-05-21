import React from "react";
import { Image } from "react-konva";
import useImage from "use-image";

function PreviewImage({ width, height, imgSRC }) {
    const [image] = useImage(imgSRC);
    if (width && height) {
        return <Image image={image} width={width} height={height} />;
    }
    return null;
}

export default PreviewImage;