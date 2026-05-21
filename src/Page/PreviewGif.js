import React, { useRef, useState, useMemo, useEffect } from "react";
import { Image } from "react-konva";
// gifler will be imported into global window object
import "gifler";
import PreviewImage from "./PreviewImage";
import { t } from '../i18n';

const GIF = ({ width, height, imgSRC }) => {
  const imageRef = useRef(null);
  const [gifType, setgifType] = useState(true);
  const canvas = useMemo(() => {
    const node = document.createElement("canvas");
    return node;
  }, []);

  useEffect(() => {
    let anim;
    const fetchData = async () => {
      // Fetch and check the GIF file header
      const response = await fetch(imgSRC);
      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      
      // Check if the file is a valid GIF
      if (uint8Array[0] === 0x47 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x38 &&
        (uint8Array[4] === 0x37 || uint8Array[4] === 0x39) && uint8Array[5] === 0x61) {
        
        // If it's a valid GIF, start the animation
        window.gifler(imgSRC).get(a => {
          anim = a;
          anim.animateInCanvas(canvas);

          // Update the canvas at each frame
          anim.onDrawFrame = (ctx, frame) => {
            ctx.drawImage(frame.buffer, frame.x, frame.y);
            // Only update the Konva layer once per frame
            imageRef.current.getLayer().batchDraw();
          };
        });

      } else {
        console.log(`${imgSRC} ${t('preview.gifFileCorrupted')}`);
        setgifType(false); // If the file is invalid, show preview image
      }
    };

    if (imgSRC) fetchData();

    // Cleanup: stop animation on component unmount
    return () => {
      if (anim) {
        anim.stop();
      }
    };
  }, [imgSRC, canvas]);

  // Render either the GIF animation or the preview image based on gifType
  return gifType ? (
    <Image image={canvas} ref={imageRef} width={width} height={height} />
  ) : (
    <PreviewImage width={width} height={height} imgSRC={imgSRC} />
  );
};

export default GIF;
