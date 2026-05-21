import React, { useRef, useState, useEffect, Fragment } from 'react';
import { Group, Image, Transformer, Rect } from "react-konva";
import useImage from 'use-image';
// import debounce from 'lodash.debounce';
import { Html } from "react-konva-utils";
import { t } from '../i18n';
// import httpsend from '../Assets/httpsend';
// import * as echarts from "echarts";

const ConElement = ({ shapeProps, id, isSelected, showSelectionFrame, isAlignmentAnchor, isHoverHighlighted, isElementHover, onHoverEnter, onHoverLeave, onSelect, onChange, onDragStart: onDragStartProp, onDragMove, toolType, onToolBack }) => {
    const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
    
    if (!shapeProps.moduleJson) {
        return false
    }
    const [imgurl] = useImage((shapeProps.moduleJson.children.length > 0 && (shapeProps.moduleJson.children[0].className === 'Image' || shapeProps.moduleJson.children[0].className === 'videoSwiper')) ? shapeProps.moduleJson.children[0].attrs.image : (shapeProps.src.indexOf('http') > -1 ? '../Images/' + shapeProps.src.split('/Images/')[0] : shapeProps.src));
    const groupRef = useRef();
    const transformRef = useRef();
    const hoverTransformRef = useRef();
    const elementHoverTransformRef = useRef();
    const [newshapeProps, setnewshapeProps] = useState(null);
    const [hoverPulseTick, setHoverPulseTick] = useState(0);
    const [divTab, setdivTab] = useState(0);

    useEffect(() => {
        if (!isHoverHighlighted) return undefined;
        const timer = window.setInterval(() => {
            setHoverPulseTick((prev) => prev + 1);
        }, 450);
        return () => window.clearInterval(timer);
    }, [isHoverHighlighted]);

    useEffect(() => {
        if (isHoverHighlighted && hoverTransformRef.current) {
            hoverTransformRef.current.nodes([groupRef.current]);
            hoverTransformRef.current.getLayer().batchDraw();
        }
    }, [isHoverHighlighted, shapeProps, hoverPulseTick]);

    useEffect(() => {
        if (isElementHover && elementHoverTransformRef.current && groupRef.current) {
            elementHoverTransformRef.current.nodes([groupRef.current]);
            elementHoverTransformRef.current.getLayer().batchDraw();
        }
    }, [isElementHover, shapeProps]);

    const toPositiveNumber = (value, fallback) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) {
            return fallback;
        }
        return num;
    };

    const toNonNegativeNumber = (value, fallback) => {
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0) {
            return fallback;
        }
        return num;
    };

    const sanitizeCanvasText = (value) => {
        const raw = value == null ? '' : String(value);
        return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    };

    const renderFirefoxTextFallback = (attrs, key, overrideText) => {
        const textValue = sanitizeCanvasText(overrideText == null ? attrs.text : overrideText);
        const fontSize = toPositiveNumber(attrs.fontSize, 18);
        const lineHeight = toPositiveNumber(attrs.lineHeight, 1);
        const padding = toNonNegativeNumber(attrs.padding, 0);
        const width = attrs.width !== undefined ? toPositiveNumber(attrs.width, 1) : undefined;
        const height = attrs.height !== undefined ? toPositiveNumber(attrs.height, 1) : undefined;
        const wrap = attrs.wrap || 'word';
        const align = attrs.align || 'left';

        const textStyle = {
            fontFamily: attrs.fontFamily || 'Arial',
            fontSize: fontSize + 'px',
            fontStyle: attrs.fontStyle || 'normal',
            lineHeight: lineHeight,
            textAlign: align === 'justify' ? 'justify' : align,
            color: attrs.fill || '#000',
            whiteSpace: wrap === 'none' ? 'pre' : 'pre-wrap',
            wordBreak: wrap === 'char' ? 'break-all' : 'break-word',
            overflow: 'hidden',
            padding: padding + 'px',
            boxSizing: 'border-box',
            width: width ? (width + 'px') : 'auto',
            height: height ? (height + 'px') : 'auto',
            opacity: attrs.opacity !== undefined ? attrs.opacity : 1,
        };

        return <Html
            key={key}
            transform
            groupProps={{
                x: Number.isFinite(Number(attrs.x)) ? Number(attrs.x) : 0,
                y: Number.isFinite(Number(attrs.y)) ? Number(attrs.y) : 0,
                rotation: Number.isFinite(Number(attrs.rotation)) ? Number(attrs.rotation) : 0,
                scaleX: Number.isFinite(Number(attrs.scaleX)) ? Number(attrs.scaleX) : 1,
                scaleY: Number.isFinite(Number(attrs.scaleY)) ? Number(attrs.scaleY) : 1,
                skewX: Number.isFinite(Number(attrs.skewX)) ? Number(attrs.skewX) : 0,
                skewY: Number.isFinite(Number(attrs.skewY)) ? Number(attrs.skewY) : 0,
            }}
            divProps={{ style: { pointerEvents: "none" } }}
        >
            <div style={textStyle}>{textValue}</div>
        </Html>;
    };

    useEffect(() => {
        if ((isSelected || showSelectionFrame) && transformRef.current) {
            transformRef.current.nodes([groupRef.current]);
            transformRef.current.getLayer().batchDraw();
            setnewshapeProps(shapeProps);
        }
    }, [isSelected, showSelectionFrame, shapeProps]);

    useEffect(() => {
        if (transformRef.current != null) {
            transformRef.current.forceUpdate();
        }
    });

    const handleDragStart = e => {
        if (e && e.evt) {
            e.evt.__draggingSelection = true;
        }
        // 先让父级有机会预初始化多选拖动状态，再走 onSelect
        if (onDragStartProp) onDragStartProp(e, shapeProps);
        onSelect(e);
    };
    
    const handleDragEnd = e => {
        
        onChange({
            ...shapeProps,
            x: e.target.x(),
            y: e.target.y(),
        });
        setnewshapeProps(shapeProps);
    };

    const handeleGroupTransformEnd = (newbox) => {
        const group = groupRef.current;
        const scaleX = group.scaleX();
        const scaleY = group.scaleY();
        const rotation = group.rotation();
        const skewX = group.skewX();
        const skewY = group.skewY();
        const newrxy = rotateAroundCenter(group, rotation);
        // shapeProps.moduleJson.children.forEach(element => {
        
        //         element.attrs.width = element.attrs.width * scaleX;
        //         element.attrs.height = element.attrs.height * scaleY;
        //     }
        // });
        let newshapeProps = {
            ...shapeProps,
            scaleX: scaleX,
            scaleY: scaleY,
            rotation: newrxy[0],
            x: newrxy[1],
            y: newrxy[2],
            skewX: skewX,
            skewY: skewY
        }
        onChange(newshapeProps);
        setnewshapeProps(newshapeProps);
    }
    
    const rotatePoint = ({ x, y }, rad) => {
        const rcos = Math.cos(rad);
        const rsin = Math.sin(rad);
        return { x: x * rcos - y * rsin, y: y * rcos + x * rsin };
    };
    function rotateAroundCenter(node, rotation) {
        const topLeft = { x: -node.width() / 2, y: -node.height() / 2 };
        const current = rotatePoint(topLeft, node.rotation());
        const rotated = rotatePoint(topLeft, rotation);

        const dx = rotated.x - current.x,
            dy = rotated.y - current.y;
        return [rotation, node.x() + dx, node.y() + dy]
    }

    const handleToolChange = (toolType) => {
        if (toolType !== null && isSelected) {
            const node = groupRef.current;
            switch (toolType) {
                case 'copy': onToolBack(newshapeProps, 'copy'); break;
                case 'del': onToolBack(newshapeProps, 'del'); break;
                case 'lock': onToolBack({ ...newshapeProps, draggable: false }, 'lock'); break;
                case 'unlock': onToolBack({ ...newshapeProps, draggable: true }, 'unlock'); break;
                case 'up': onToolBack('', 'up'); node.moveUp(); break;
                case 'down': onToolBack('', 'down'); node.moveDown(); break
                case 'top': onToolBack('', 'top'); node.moveToTop(); break;
                case 'bottom': onToolBack('', 'bottom'); node.moveToBottom(); node.moveUp(); break;
                default: break;
            }
        }
    }

    // const debounceHandleInfo = debounce((newBox) => {
    //     if (transformRef.current) {
    //         transformRef.current.forceUpdate();
    //         handeleGroupTransformEnd(newBox)
    //     }
    // }, 100)

    return (
        <Fragment>
            <Group
                id={id}
                onDragStart={handleDragStart}
                onDragMove={(e) => { if (onDragMove) onDragMove(e, shapeProps); }}
                onDragEnd={handleDragEnd}
                onMouseEnter={() => { if (onHoverEnter) onHoverEnter(shapeProps); }}
                onMouseLeave={() => { if (onHoverLeave) onHoverLeave(shapeProps); }}
                onClick={onSelect}
                onTap={onSelect}
                handleTool={isSelected && handleToolChange(toolType)}
                {...shapeProps}
                ref={groupRef}
                onTransformEnd={(newbox) => isSelected && shapeProps.draggable && handeleGroupTransformEnd(newbox)}
                name="group"
            >
                {shapeProps.moduleJson.children.map((img, i) => {
                    const Ele = img.className;
                    if (Ele === 'Image' || Ele === 'videoSwiper') {
                        // console.log(imgurl);
                        if (imgurl) {
                            return <Image
                                key={i}
                                {...img.attrs}
                                image={imgurl}
                            />
                        } else {
                            
                            return <Fragment key={i}>
                                <Html divProps={{ style: { pointerEvents: "none" } }}>
                                    <img src="../Images/icon/error.png" width={img.attrs.width} height={img.attrs.height} alt=""/>
                                </Html>
                                <Rect width={img.attrs.width} height={img.attrs.height} />
                            </Fragment>
                        }
                    } else if (Ele === 'Echart') {
                        let htmlId = 'Echart' + id;
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="chart" id={htmlId} style={{ width: img.attrs.width, height: img.attrs.height }}></div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'wetHtml') {
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="numstatus">
                                    <div>{img.attrs.text}</div>
                                    <span>23.3</span>
                                    <span>℃</span>
                                    <span>23.3</span>
                                    <span>%</span>
                                </div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'leakWater') {
                        let alarmPos=0;
                        let ropeAlarmRange=1;
                        let realarmPos=0;
                        let ropeAlarmRangeTxt ='';
                        
                        if(img.attrs.data>=img.attrs.ropeStart && img.attrs.data<=img.attrs.ropeEnd){
                            let totalW = parseFloat(img.attrs.ropeEnd)-parseFloat(img.attrs.ropeStart);
                            let zuW = parseFloat(img.attrs.width);
                            let newData = parseFloat(img.attrs.data)-parseFloat(img.attrs.ropeStart);
                            let calcW = zuW/totalW 
                            ropeAlarmRange=calcW*img.attrs.ropeAlarmRange;
                            alarmPos = (newData/totalW)*totalW*ropeAlarmRange - ropeAlarmRange/2;
                            realarmPos = zuW - alarmPos;
                            let ropeAlarmRangeS = Number(Number(img.attrs.data) - Number(img.attrs.ropeAlarmRange)/2).toFixed(2).toString();
                            let ropeAlarmRangeE = Number(Number(img.attrs.data) + Number(img.attrs.ropeAlarmRange)/2).toFixed(2).toString();
                            ropeAlarmRangeTxt = ropeAlarmRangeS +'-'+ ropeAlarmRangeE;
                            // console.log(ropeAlarmRange)
                            // console.log(alarmPos)
                        }
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="rope" style={{ width: img.attrs.width, height: img.attrs.height }}>
                                    
                                    {img.attrs.ropeDirection === '2' && <div className="ropeRed ropeRev" style={{ width: ropeAlarmRange,right:alarmPos}}>
                                        <img src="../Images/icon/water.gif" className="ropeIcon" alt=""/></div>}
                                    {img.attrs.ropeDirection === '1' && <div className="ropeRed" style={{ width: ropeAlarmRange,left:alarmPos}}>
                                        <img src="../Images/icon/water.gif" className="ropeIcon" alt=""/></div>}
                                    
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumS" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumS" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumS" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumS" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumE" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumE" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumE" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumE" style={{ color: img.attrs.ropeDataColor,fontSize:img.attrs.ropeDataSize}}>{img.attrs.ropeEnd}</div>}
                                    
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '1' && img.attrs.ropeDirection === '1' && <div className="bubble bubbleTop" style={{left:alarmPos-22}}>
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '2' && img.attrs.ropeDirection === '1' && <div className="bubble bubbleBottom" style={{left:alarmPos-22}}>
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '1' && img.attrs.ropeDirection === '2' && <div className="bubble bubbleTop" style={{left:realarmPos-38}}>
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '2' && img.attrs.ropeDirection === '2' && <div className="bubble bubbleBottom" style={{left:realarmPos-38}}>
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '3' && <div className="bubble bubbleLeft">
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '4' && <div className="bubble bubbleRight">
                                        <div>
                                            <label>{t('preview.leakPointPosition')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('preview.alarmArea')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                </div>
                            </Html>
                            <Rect width={img.attrs.width+400} height={img.attrs.height+160} />
                        </Fragment>
                    } else if (Ele === 'paoHtml') {
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="tipstxt" style={{ width: img.attrs.width, height: img.attrs.height }}>{img.attrs.text}</div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'pueHtml') {
                        let chartId = 'Echart' + id;
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="chart" id={chartId} style={{ width: img.attrs.width, height: img.attrs.height }}></div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'paraHtml') {
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="param-status" style={{ width: img.attrs.width, height: img.attrs.height, opacity: img.attrs.opacity, backgroundColor: img.attrs.background }}>
                                    <div className="param-statustitle" style={{ fontSize: img.attrs.tabSize, color: img.attrs.tabColor }}>
                                        {img.attrs.dataSwitch === '2' && <div className={divTab === 0 ? "param-statustitle-check" : ""} onClick={() => setdivTab(0)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('preview.parameter')}</label></div>}
                                        {img.attrs.stateSwitch === '2' && <div className={divTab === 1 ? "param-statustitle-check" : ""} onClick={() => setdivTab(1)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('preview.status')}</label></div>}
                                        {img.attrs.alarmSwitch === '2' && <div className={divTab === 2 ? "param-statustitle-check" : ""} onClick={() => setdivTab(2)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('preview.alarm')}</label></div>}
                                    </div>
                                    <div className="param-statusbox">
                                        <table style={divTab === 0 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.parameterName')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.value')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.unit')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>2.0</td>
                                                    <td>A</td>
                                                </tr>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>265</td>
                                                    <td>V</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                        <table style={divTab === 1 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.parameterName')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.valueDescription')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>{t('preview.normal')}</td>
                                                </tr>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>{t('preview.normal')}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                        <table style={divTab === 2 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.parameterName')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('preview.valueDescription')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>{t('preview.normal')}</td>
                                                </tr>
                                                <tr>
                                                    <td>{t('preview.parameter')}</td>
                                                    <td>{t('preview.alarm')}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'alarmList') {
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="alarmList" style={{ width: img.attrs.width, height: img.attrs.height, backgroundColor: 'transparent' }}>
                                    <table>
                                        <thead style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor, lineHeight: img.attrs.theadlineHeight ,backgroundColor: img.attrs.theadbgColor}}>
                                            <tr>
                                                <th>{t('preview.alarmEvent')}</th>
                                                <th>{t('preview.alarmLevel')}</th>
                                                <th>{t('preview.alarmTime')}</th>
                                            </tr>
                                        </thead>
                                        <tbody style={{ fontSize: img.attrs.tbodySize, lineHeight: img.attrs.lineHeight }}>
                                            {img.attrs.data && img.attrs.data.map((val, n) => {
                                                return <tr key={i + n + 0} className={val.colorName}>
                                                    <td>{val.AlarmName}</td>
                                                    <td>{val.LevelName}</td>
                                                    <td>{val.AlarmTime}</td>
                                                </tr>
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else {
                        const nextAttrs = { ...img.attrs };
                        if (img.attrs.name === 'curTime') {
                            let date = new Date();
                            let newdate = date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) 

                            switch (img.attrs.type) {
                                case '1': nextAttrs.text = newdate; break;
                                case '2': nextAttrs.text = newdate.replaceAll('/', '-'); break;
                                case '3': nextAttrs.text = newdate.split(' ')[0]; break;
                                case '4': nextAttrs.text = newdate.split(' ')[0].replaceAll('/', '-'); break;
                                case '5': nextAttrs.text = newdate.split(' ')[1]; break;//h:m:s
                                default: break;
                            }
                        }
                        if (isFirefox && (Ele === 'Text' || Ele === 'TextPath')) {
                            return renderFirefoxTextFallback(nextAttrs, i, nextAttrs.text);
                        }
                        return <Ele
                            key={i}
                            {...nextAttrs}
                        />
                    }

                })}
            </Group>
            {isHoverHighlighted && (
                <Transformer
                    ref={hoverTransformRef}
                    borderStroke="#13c2c2"
                    borderStrokeWidth={hoverPulseTick % 2 === 0 ? 3 : 1}
                    anchorSize={0}
                    resizeEnabled={false}
                    rotateEnabled={false}
                    listening={false}
                />
            )}
            {(isElementHover && !isSelected && !showSelectionFrame && !isHoverHighlighted) && (
                <Transformer
                    ref={elementHoverTransformRef}
                    borderStroke={shapeProps.draggable === false ? '#ff7875' : '#13c2c2'}
                    borderStrokeWidth={1}
                    anchorSize={0}
                    resizeEnabled={false}
                    rotateEnabled={false}
                    listening={false}
                />
            )}
            {(isSelected && shapeProps.draggable) && (
                <Transformer
                    ref={transformRef}
                    flipEnabled={false}
                    boundBoxFunc={(oldBox, newBox) => {
                        if (newBox.width < 5 || newBox.height < 5) {
                            return oldBox;
                        }
                        // debounceHandleInfo(newBox)
                        return newBox;
                    }}
                />
            )}
            {(!isSelected && showSelectionFrame && shapeProps.draggable) && (
                <Transformer
                    ref={transformRef}
                    borderStroke={isAlignmentAnchor ? "#9254de" : "#52c41a"}
                    borderStrokeWidth={isAlignmentAnchor ? 2 : 1}
                    anchorSize={0}
                    resizeEnabled={false}
                    rotateEnabled={false}
                    listening={false}
                    flipEnabled={false}
                />
            )}
            {(isSelected && !shapeProps.draggable) && (
                <Transformer
                    borderStroke='#CCC'
                    borderStrokeWidth={5}
                    resizeEnabled={false}
                    rotateEnabled={false}
                    ref={transformRef}
                />
            )}
        </Fragment>
    );
};

export default ConElement;
