import React, { useRef, useState, Fragment, useEffect } from 'react';
import { t } from '../i18n';
// import { Group, Image, Rect } from "react-konva";
import { Group, Rect } from "react-konva";
import { Html } from "react-konva-utils";
import httpsend from '../Assets/httpsend';
import { Close } from '@mui/icons-material';
import { message, Button } from 'antd';
import PreviewImage from "./PreviewImage";
import axios from 'axios';
import { buildMainApiUrl } from '../config/endpoints';
import PreviewGif from "./PreviewGif.js";

const PreviewElement = ({ shapeProps, id, wheight, wwidth, wscale, onhandleResize, isSwiper }) => {
    // console.log(shapeProps);
    const clickEvnt = shapeProps.clickEvnt || (shapeProps.moduleJson && shapeProps.moduleJson.clickEvnt) || [];
    const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
    const groupRef = useRef();
    const [divTab, setdivTab] = useState(0);
    const [isModalOpen, setIsModalOpen] = useState(false);
    // const [imgurl, setimgurl] = useState((shapeProps.moduleJson.children.length > 0 && shapeProps.moduleJson.children[0].className === 'Image') ? shapeProps.moduleJson.children[0].attrs.image : (shapeProps.src.indexOf('http') > -1 ? '../Images/' + shapeProps.src.split('/Images/')[0] : shapeProps.src));
    const [imgurl, setimgurl] = useState('Images/icon/full.png');// Comment translated to English.
    // Comment translated to English.
    const curTimeNodeRef = useRef(null);
    const curTimeTextRef = useRef('');
    const [curTimeInitText, setCurTimeInitText] = useState('');
    // Comment translated to English.
    const [backBtn, setbackBtn] = useState(false);
    const [dealweblink, setdealweblink] = useState();// Comment translated to English.
    const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);// Comment translated to English.
    const [dealVideo, setdealVideo] = useState();// Comment translated to English.

    const pad2 = (value) => {
        const num = Number(value);
        return num < 10 ? ('0' + num) : String(num);
    };

    const sanitizeCanvasText = (value) => {
        const raw = value == null ? '' : String(value);
        return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    };

    const getCurTimeTextByType = (type) => {
        let date = new Date();
        let y = date.getFullYear();
        let m = pad2(date.getMonth() + 1);
        let d = pad2(date.getDate());
        let hh = pad2(date.getHours());
        let mm = pad2(date.getMinutes());
        let ss = pad2(date.getSeconds());
        let dateSlash = y + '/' + m + '/' + d;
        let dateDash = y + '-' + m + '-' + d;
        let time = hh + ':' + mm + ':' + ss;
        switch (String(type)) {
            case '1': return sanitizeCanvasText(dateSlash + ' ' + time); // y/m/d h:m:s
            case '2': return sanitizeCanvasText(dateDash + ' ' + time); // y-m-d h:m:s
            case '3': return sanitizeCanvasText(dateSlash); // y/m/d
            case '4': return sanitizeCanvasText(dateDash); // y-m-d
            case '5': return sanitizeCanvasText(time); // h:m:s
            default: return sanitizeCanvasText(dateSlash + ' ' + time);
        }
    };

    const normalizeTextAttrs = (attrs) => {
        if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, 'text')) {
            return attrs;
        }
        return {
            ...attrs,
            text: attrs.text == null ? '' : String(attrs.text),
        };
    };

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

    const sanitizeKonvaAttrs = (nodeType, attrs) => {
        if (!attrs) {
            return attrs;
        }
        if (nodeType !== 'Text') {
            return attrs;
        }
        const next = {
            ...attrs,
            text: attrs.text == null ? '' : String(attrs.text),
            fontSize: toPositiveNumber(attrs.fontSize, 18),
            lineHeight: toPositiveNumber(attrs.lineHeight, 1),
            padding: toNonNegativeNumber(attrs.padding, 0),
            letterSpacing: Number.isFinite(Number(attrs.letterSpacing)) ? Number(attrs.letterSpacing) : 0,
        };
        next.fontFamily = (typeof attrs.fontFamily === 'string' && attrs.fontFamily.trim()) ? attrs.fontFamily : 'Arial';
        next.fontStyle = (typeof attrs.fontStyle === 'string' && attrs.fontStyle.trim()) ? attrs.fontStyle : 'normal';
        next.fontVariant = (typeof attrs.fontVariant === 'string' && attrs.fontVariant.trim()) ? attrs.fontVariant : 'normal';
        if (attrs.width !== undefined) {
            next.width = toPositiveNumber(attrs.width, 1);
        }
        if (attrs.height !== undefined) {
            next.height = toPositiveNumber(attrs.height, 1);
        }
        if (attrs.wrap !== undefined && attrs.wrap !== 'word' && attrs.wrap !== 'char' && attrs.wrap !== 'none') {
            next.wrap = 'word';
        }
        return next;
    };

    const renderFirefoxTextFallback = (attrs, key, overrideText) => {
        const textValue = sanitizeCanvasText(overrideText == null ? attrs.text : overrideText);
        const fontSize = toPositiveNumber(attrs.fontSize, 18);
        const lineHeight = toPositiveNumber(attrs.lineHeight, 1);
        const padding = toNonNegativeNumber(attrs.padding, 0);
        const left = Number.isFinite(Number(attrs.x)) ? Number(attrs.x) : 0;
        const top = Number.isFinite(Number(attrs.y)) ? Number(attrs.y) : 0;
        const width = attrs.width !== undefined ? toPositiveNumber(attrs.width, 1) : undefined;
        const height = attrs.height !== undefined ? toPositiveNumber(attrs.height, 1) : undefined;
        const wrap = attrs.wrap || 'word';
        const align = attrs.align || 'left';
        const textColor = attrs.fill || '#000';

        const textStyle = {
            fontFamily: attrs.fontFamily || 'Arial',
            fontSize: fontSize + 'px',
            fontStyle: attrs.fontStyle || 'normal',
            lineHeight: lineHeight,
            textAlign: align === 'justify' ? 'justify' : align,
            color: textColor,
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
                x: left,
                y: top,
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
        let newshapeProps = JSON.parse(JSON.stringify(shapeProps));
        if (newshapeProps.moduleJson.children && newshapeProps.moduleJson.children[0].attrs.alarmSwitch === '2') {
            setdivTab(2)
        }
        if (newshapeProps.moduleJson.children && newshapeProps.moduleJson.children[0].attrs.stateSwitch === '2') {
            setdivTab(1)
        }
        if (newshapeProps.moduleJson.children && newshapeProps.moduleJson.children[0].attrs.dataSwitch === '2') {
            setdivTab(0)
        }
    }, [])

    useEffect(() => {
        const children = (shapeProps && shapeProps.moduleJson && shapeProps.moduleJson.children) ? shapeProps.moduleJson.children : [];
        const curTimeNode = children.find((item) => item && item.attrs && item.attrs.name === 'curTime');
        if (!curTimeNode) {
            curTimeTextRef.current = '';
            setCurTimeInitText('');
            return undefined;
        }

        const tick = () => {
            const nextText = getCurTimeTextByType(curTimeNode.attrs.type);
            curTimeTextRef.current = nextText;
            if (isFirefox) {
                setCurTimeInitText((prev) => (prev === nextText ? prev : nextText));
                return;
            }
            if (curTimeNodeRef.current) {
                try {
                    curTimeNodeRef.current.text(nextText);
                    const layer = curTimeNodeRef.current.getLayer();
                    if (layer) {
                        layer.batchDraw();
                    }
                } catch (e) {
                    console.error('curTime update failed', e);
                }
            }
        };
        tick();

        const timerId = setInterval(tick, 1000);
        return () => clearInterval(timerId);
    }, [shapeProps, isFirefox]);

    const dealClick = async () => {
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        if (clickEvnt[0]['link'] || clickEvnt[0]['weblink'] || clickEvnt[0]['pagekey']) {
            setbackBtn(true);
            if (clickEvnt[0]['weblink']) {
                let conres = await httpsend.getData('GetDmpageDetailKey', { id: clickEvnt[0]['weblink'] });
                if (conres) {
                    if (conres.data) {
                        setdealweblink(httpsend.mainURL() + 'index.html?type=preview&title=' + conres.data.PageTxt)
                    } else {
                        setbackBtn(false);
                        message.error(t('auto.k0203'));
                    }
                }
            }
            if (clickEvnt[0]['pagekey']) {
                // Comment translated to English.
                let textIds = [];
                // Comment translated to English.
                // console.log(shapeProps);
                let ani = shapeProps.moduleJson.children[0].attrs.ani;
                let anitime = shapeProps.moduleJson.children[0].attrs.anitime;
                let anispeed = shapeProps.moduleJson.children[0].attrs.anispeed;
                clickEvnt.forEach((item, index) => {
                    textIds.push(item['pagekey']);
                })
                // setplayimgurl('Images/icon/playend.png');
                setdealweblink(httpsend.viewURL() + '/donghuan-dcim-swiper.html?ids=' + textIds.join(',') + '&ani=' + ani + '&anitime=' + anitime + '&anispeed=' + anispeed);
            }
        } else if (clickEvnt[0]['newlink']) {
            const w = window.open('about:blank');
            w.location.href = clickEvnt[0]['newlink'];
            // Comment translated to English.
        } else if (clickEvnt[0]['full']) {
            if (!document.fullscreenElement) {
                // Comment translated to English.
                document.documentElement.requestFullscreen().then(() => {
                    onhandleResize('full');
                    setimgurl('Images/icon/exitfull.png');
                });
            } else {
                // Comment translated to English.
                if (document.exitFullscreen) {
                    document.exitFullscreen().then(() => {
                        onhandleResize('full');
                        setimgurl('Images/icon/full.png');
                    });
                }
            }
        } else if (clickEvnt[0]['videoChannel']) {
            let videoIds = [];
            clickEvnt.forEach((item, index) => {
                videoIds.push(item['videoChannel']);
            })
            showVideoModal(httpsend.viewURL() + 'donghuan-dcim-video.html?ids=' + videoIds.join(','));
            // setdealweblink(httpsend.viewURL() + 'donghuan-dcim-video.html?ids=' + videoIds.join(','));
        } else {
            // Comment translated to English.
            if (shapeProps.tipsVal === '2') {
                dealCommandSend();
            } else {
                setIsModalOpen(true);
            }
        }
    }

    const dealCommandSend = async () => {
        if (clickEvnt.length > 0) {
            for (let i = 0; i < clickEvnt.length; i++) {
                // clickEvnt.forEach(async (element, n) => {
                let element = clickEvnt[i];
                let onlycode = await httpsend.getData('GetDeviceDetailKey', {
                    id: element.devkey,
                    token: 'b57b88e5af6331d7b9d7151119ccbfda'
                });
                let paramCommand = {
                    DevID: element.devkey,
                    Command: element.command,
                    RecvData: '',
                    SendState: '0'
                }
                if (onlycode && onlycode.data && onlycode.data.OnlyCode) {
                    paramCommand.RecvData = t('auto.k0204')
                    paramCommand.SendState = '1'
                    let serverip = await httpsend.getData('GetServerListKey', {
                        token: 'b57b88e5af6331d7b9d7151119ccbfda',
                        ComboBox: 'all'
                    });
                    if (serverip) {
                        let serveripindex = serverip.data.findIndex(v => v.ServerCode === onlycode.data.ServerCode)
                        let sendip = serverip.data[serveripindex]['ServerIP']
                        const url = buildMainApiUrl('CreateDeviceCommandSendKey', sendip);
                        const data = {
                            'DevID': onlycode.data.OnlyCode,
                            'Command': element.command
                        };
                        axios.post(url, data).then(async (response) => {
                            await httpsend.getData('CreateDeviceCommandSendKey', paramCommand);
                        }).catch(error => {
                            // Comment translated to English.
                            console.error('Error:', error);
                        });
                    }
                } else {
                    await httpsend.getData('CreateDeviceCommandSendKey', paramCommand);
                }
                if (i + 1 === clickEvnt.length) {
                    console.log(t('auto.k0205'))
                    message.success(t('auto.k0205'));
                }
                // });
            }
        } else {
            console.error('Error:', t('auto.k0447'));
        }
    }
    // Comment translated to English.
    const getcalculateDays = () => {
        let date = new Date();
        let newdate = date.toLocaleString('chinese', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) // Comment translated to English.
        let endTime = newdate.split(' ')[0];
        let startTime = localStorage.getItem('SystemStartTime') ? localStorage.getItem('SystemStartTime').split(' ')[0] : endTime;// Comment translated to English.
        let days = calculateDays(startTime, endTime);
        // console.log(days);
        let daysTxt = days.toString();// Comment translated to English.
        // console.log(daysTxt)
        if (daysTxt.length === 1) {
            daysTxt = '00000' + daysTxt;
        } else if (daysTxt.length === 2) {
            daysTxt = '0000' + daysTxt;
        } else if (daysTxt.length === 3) {
            daysTxt = '000' + daysTxt
        } else if (daysTxt.length === 4) {
            daysTxt = '00' + daysTxt
        } else if (daysTxt.length === 5) {
            daysTxt = '0' + daysTxt
        };
        // console.log(daysTxt)
        return daysTxt;
    }

    // Comment translated to English.
    const calculateDays = (start, end) => {
        let oneDay = 24 * 60 * 60 * 1000; // Comment translated to English.
        let startDate = new Date(start);
        let endDate = new Date(end);
        let diff = endDate - startDate; // Comment translated to English.
        return Math.round(diff / oneDay); // Comment translated to English.
    };

    // Comment translated to English.
    const showVideoModal = (url) => {
        setdealVideo(url);
        setIsVideoModalOpen(true);
    };
    // Comment translated to English.
    const handleVideoCancel = () => {
        setIsVideoModalOpen(false);
        setdealVideo('');
    };

    return (
        <Fragment>
            {shapeProps && <Group
                id={id}
                {...shapeProps}
                ref={groupRef}
                name="group"
                draggable={false}
                // onClick={() => clickEvnt ? setIsModalOpen(true) : null}
                onClick={() => (clickEvnt && clickEvnt.length > 0) ? dealClick() : null}
                onTap={() => (clickEvnt && clickEvnt.length > 0) ? dealClick() : null}
            >
                {shapeProps.moduleJson.children.map((img, i) => {
                    const Ele = img.className;
                    let typearr = [];
                    let type = '';
                    if (shapeProps.moduleJson.attrs && shapeProps.moduleJson.attrs.moduleAttr[0] && shapeProps.moduleJson.attrs.moduleAttr[0]['attrGroupContent']) {
                        typearr = shapeProps.moduleJson.attrs.moduleAttr[0]['attrGroupContent'];
                        let findtypeindex = typearr.findIndex(v => v.attrType === "rotateTableNewNew");// Comment translated to English.
                        if (findtypeindex > -1) {
                            type = 'rotate';
                        }
                    }
                    if (Ele === 'Image') {
                        if (clickEvnt && clickEvnt.length > 0 && clickEvnt[0].full) {// Comment translated to English.
                            return <PreviewImage key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={imgurl} /> // Comment translated to English.
                        } else if (img.attrs.name === 'pageIn') {
                            if (img.attrs.URL) {
                                return <Fragment key={i}>
                                    <Html>
                                        <iframe
                                            title="Myiframe"
                                            src={img.attrs.URL.indexOf('http') > -1 ? img.attrs.URL : httpsend.viewURL() + '/3d/' + img.attrs.URL}
                                            width={img.attrs.width + 'px'}
                                            height={img.attrs.height + 'px'}
                                            frameBorder="0"
                                            allowFullScreen
                                            scrolling='no'
                                        ></iframe>
                                    </Html>
                                </Fragment>
                            } else {
                                return <PreviewImage key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.image} />
                            }
                        } else if (img.attrs.name === 'ipImage') {
                            // console.log(img.attrs.name)
                            // console.log(img.attrs)
                            if (img.attrs.haveAlarm === '1') {
                                if (img.attrs.alarmImage.indexOf('.gif') > -1) {// Comment translated to English.
                                    return <PreviewGif key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.alarmImage} />
                                } else {
                                    return <PreviewImage key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.alarmImage} />
                                }
                            } else {
                                if (img.attrs.image.indexOf('.gif') > -1) {// Comment translated to English.
                                    return <PreviewGif key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.image} />
                                } else {
                                    return <PreviewImage key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.image} />
                                }
                            }
                        } else {
                            if (type) {
                                return <Fragment key={i}>
                                    <Html>
                                        <img style={{ width: img.attrs.width, height: img.attrs.height }} src={img.attrs.image} alt={img.attrs.image} />
                                    </Html>
                                    <Rect width={img.attrs.width} height={img.attrs.height} />
                                </Fragment>
                            } else {
                                if (img.attrs.image.indexOf('.gif') > -1) {// Comment translated to English.
                                    return <PreviewGif key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.image} />
                                } else {
                                    return <PreviewImage key={i} width={img.attrs.width} height={img.attrs.height} imgSRC={img.attrs.image} />
                                }
                            }
                        }
                    } else if (Ele === 'Echart') {// Comment translated to English.
                        let htmlId = 'Echart' + id;
                        return <Fragment key={i}>
                            <Html>
                                <div className="chart" id={htmlId} style={{ width: img.attrs.width, height: img.attrs.height }}></div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'wetHtml') {// Comment translated to English.
                        return <Fragment key={i}>
                            <Html>
                                <div className="numstatus">
                                    <div>{img.attrs.text}</div>
                                    <span style={{ 'color': img.attrs.fill1 }}>{img.attrs.dataWen}</span>
                                    <span>℃</span>
                                    <span style={{ 'color': img.attrs.fill2 }}>{img.attrs.dataWet}</span>
                                    <span>%</span>
                                </div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'leakWater') {// Comment translated to English.
                        // Comment translated to English.
                        // console.log(img)
                        let alarmPos = 0;
                        let ropeAlarmRange = 1;
                        let realarmPos = 0;
                        let ropeAlarmRangeTxt = '';
                        let leakHaveAlarm = img.attrs.haveAlarm;
                        // Comment translated to English.
                        if (img.attrs.data >= img.attrs.ropeStart && img.attrs.data <= img.attrs.ropeEnd) {
                            let totalW = parseFloat(img.attrs.ropeEnd) - parseFloat(img.attrs.ropeStart);
                            let zuW = parseFloat(img.attrs.width);
                            let newData = parseFloat(img.attrs.data) - parseFloat(img.attrs.ropeStart);
                            let calcW = zuW / totalW // Comment translated to English.
                            ropeAlarmRange = calcW * img.attrs.ropeAlarmRange;
                            alarmPos = (newData / totalW) * totalW * ropeAlarmRange - ropeAlarmRange / 2;
                            realarmPos = zuW - alarmPos;
                            let ropeAlarmRangeS = Number(Number(img.attrs.data) - Number(img.attrs.ropeAlarmRange) / 2).toFixed(2).toString();
                            let ropeAlarmRangeE = Number(Number(img.attrs.data) + Number(img.attrs.ropeAlarmRange) / 2).toFixed(2).toString();
                            ropeAlarmRangeTxt = ropeAlarmRangeS + '-' + ropeAlarmRangeE;
                            // console.log(ropeAlarmRange)
                            // console.log(alarmPos)
                        } else {
                            leakHaveAlarm = '0';
                        }
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="rope" style={{ width: img.attrs.width, height: img.attrs.height }}>
                                    {/* Comment translated to English. */}
                                    {leakHaveAlarm === '1' && img.attrs.ropeDirection === '2' && <div className="ropeRed ropeRev" style={{ width: ropeAlarmRange, right: alarmPos }}>
                                        <img src="../Images/icon/water.gif" className="ropeIcon" alt="" /></div>}
                                    {leakHaveAlarm === '1' && img.attrs.ropeDirection === '1' && <div className="ropeRed" style={{ width: ropeAlarmRange, left: alarmPos }}>
                                        <img src="../Images/icon/water.gif" className="ropeIcon" alt="" /></div>}
                                    {/* Comment translated to English. */}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumS ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '2' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumE ropeRev" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumS" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumS" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumS" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumS" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeStart}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '1' && <div className="ropeNumTop ropeNumE" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '2' && <div className="ropeNumBottom ropeNumE" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '3' && <div className="ropeNumLeft ropeNumE" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}
                                    {img.attrs.ropeDataShow === '2' && img.attrs.ropeDirection === '1' && img.attrs.ropeDataShowPos === '4' && <div className="ropeNumRight ropeNumE" style={{ color: img.attrs.ropeDataColor, fontSize: img.attrs.ropeDataSize }}>{img.attrs.ropeEnd}</div>}

                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '1' && img.attrs.ropeDirection === '1' && <div className="bubble bubbleTop" style={{ left: alarmPos - 22 }}>
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '2' && img.attrs.ropeDirection === '1' && <div className="bubble bubbleBottom" style={{ left: alarmPos - 22 }}>
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '1' && img.attrs.ropeDirection === '2' && <div className="bubble bubbleTop" style={{ left: realarmPos - 38 }}>
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '2' && img.attrs.ropeDirection === '2' && <div className="bubble bubbleBottom" style={{ left: realarmPos - 38 }}>
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '3' && <div className="bubble bubbleLeft">
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                    {leakHaveAlarm === '1' && img.attrs.ropeAlarmBoxShow === '2' && img.attrs.ropeAlarmBoxPos === '4' && <div className="bubble bubbleRight">
                                        <div>
                                            <label>{t('auto.k0206')}</label>
                                            <span>{img.attrs.data}</span>m
                                        </div>
                                        <div>
                                            <label>{t('auto.k0207')}</label>
                                            <span>{ropeAlarmRangeTxt}</span>m
                                        </div>
                                    </div>
                                    }
                                </div>
                            </Html>
                            <Rect width={img.attrs.width + 400} height={img.attrs.height + 160} />
                        </Fragment>
                    } else if (Ele === 'paoHtml') {// Comment translated to English.
                        return <Fragment key={i}>
                            <Html divProps={{ style: { pointerEvents: "none" } }}>
                                <div className="tipstxt" style={{ width: img.attrs.width, height: img.attrs.height, 'color': img.attrs.fill }}>{img.attrs.text}</div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'pueHtml') {// Comment translated to English.
                        let chartId = 'Echart' + id;
                        return <Fragment key={i}>
                            <Html>
                                <div className="chart" id={chartId} style={{ width: img.attrs.width, height: img.attrs.height }}></div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'paraHtml') {// Comment translated to English.
                        return <Fragment key={i}>
                            <Html>
                                <div className="param-status" style={{ width: img.attrs.width, height: img.attrs.height, opacity: img.attrs.opacity, backgroundColor: img.attrs.background }}>
                                    <div className="param-statustitle" style={{ fontSize: img.attrs.tabSize, color: img.attrs.tabColor }}>
                                        {img.attrs.dataSwitch === '2' && <div className={divTab === 0 ? "param-statustitle-check" : ""} onClick={() => setdivTab(0)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('auto.k0119')}</label></div>}
                                        {img.attrs.stateSwitch === '2' && <div className={divTab === 1 ? "param-statustitle-check" : ""} onClick={() => setdivTab(1)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('auto.k0208')}</label></div>}
                                        {img.attrs.alarmSwitch === '2' && <div className={divTab === 2 ? "param-statustitle-check" : ""} onClick={() => setdivTab(2)} style={{ borderColor: img.attrs.tabshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.tabshadowColor + " inset" }}><label>{t('auto.k0209')}</label></div>}
                                    </div>
                                    <div className="param-statusbox" style={{ height: img.attrs.height - 64 }}>
                                        <table style={divTab === 0 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0210')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0211')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0212')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                {img.attrs.data1 && img.attrs.data1.map((val, n) => {
                                                    return <tr key={i + n + 0}>
                                                        <td>{val.name}</td>
                                                        <td>{val.value}</td>
                                                        <td>{val.unit}</td>
                                                    </tr>
                                                })}
                                            </tbody>
                                        </table>
                                        <table style={divTab === 1 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0210')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0213')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                {img.attrs.data2 && img.attrs.data2.map((val, n) => {
                                                    return <tr key={i + n + 1}>
                                                        <td>{val.name}</td>
                                                        <td>{val.value}</td>
                                                    </tr>
                                                })}
                                            </tbody>
                                        </table>
                                        <table style={divTab === 2 ? { 'display': 'table' } : { 'display': 'none' }}>
                                            <thead>
                                                <tr style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor }}>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0210')}</th>
                                                    <th style={{ borderColor: img.attrs.theadshadowColor, boxShadow: "0 0 8px 5px " + img.attrs.theadshadowColor + " inset" }}>{t('auto.k0213')}</th>
                                                </tr>
                                            </thead>
                                            <tbody style={{ fontSize: img.attrs.tbodySize, color: img.attrs.tbodyColor, lineHeight: img.attrs.lineHeight }}>
                                                {img.attrs.data3 && img.attrs.data3.map((val, n) => {
                                                    return <tr key={i + n + 2}>
                                                        <td>{val.name}</td>
                                                        <td>{val.value}</td>
                                                    </tr>
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </Html>
                            <Rect width={img.attrs.width} height={img.attrs.height} />
                        </Fragment>
                    } else if (Ele === 'alarmList') {// Comment translated to English.
                        return <Fragment key={i}>
                            <Html>
                                <div className="alarmList" style={{ width: img.attrs.width, height: img.attrs.height, backgroundColor: 'transparent' }}>
                                    <table>
                                        <thead style={{ fontSize: img.attrs.theadSize, color: img.attrs.theadColor, lineHeight: img.attrs.theadlineHeight, backgroundColor: img.attrs.theadbgColor }}>
                                            <tr>
                                                <th>{t('auto.k0214')}</th>
                                                <th>{t('auto.k0215')}</th>
                                                <th>{t('auto.k0216')}</th>
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
                        // console.log(Ele);
                        const safeAttrs = sanitizeKonvaAttrs(Ele, img.attrs);
                        let textForRender = safeAttrs.text;
                        if (img.attrs.name === 'curTime') {
                            textForRender = String((isFirefox ? curTimeInitText : curTimeTextRef.current) || getCurTimeTextByType(img.attrs.type) || '');
                        } else if (img.attrs.name === 'runDay') {
                            textForRender = getcalculateDays();
                        } else if (safeAttrs.text === t('auto.k0012')) {
                            textForRender = t('auto.k0217');
                        }
                        if (isFirefox && (Ele === 'Text' || Ele === 'TextPath')) {
                            return renderFirefoxTextFallback(safeAttrs, i, textForRender);
                        }
                        if (img.attrs.name === 'curTime') {// Comment translated to English.
                            return <Ele
                                key={i}
                                ref={(node) => {
                                    if (node && !isFirefox) {
                                        curTimeNodeRef.current = node;
                                    }
                                }}
                                {...safeAttrs}
                                text={textForRender}
                            />
                        } else if (img.attrs.name === 'runDay') {// Comment translated to English.
                            const runDayAttrs = {
                                ...safeAttrs,
                                text: textForRender,
                            };
                            return <Ele
                                key={i}
                                {...normalizeTextAttrs(runDayAttrs)}
                            />
                        } else {
                            if (safeAttrs.text === t('auto.k0012')) {
                                const pendingAttrs = {
                                    ...safeAttrs,
                                    text: textForRender,
                                };
                                return <Ele
                                    key={i}
                                    {...normalizeTextAttrs(pendingAttrs)}
                                />
                            } else {
                                return <Ele
                                    key={i}
                                    {...normalizeTextAttrs(safeAttrs)}
                                />
                            }
                        }
                    }
                })}
            </Group>}
            {isModalOpen && <Fragment key='0002'>
                <Html>
                    <div className="layui-layer" style={isModalOpen ? { 'display': 'block', 'width': '300px', 'left': 'calc(50vw - 150px)' } : { 'display': 'none' }}>
                        <div className="layui-layer-title">{t('auto.k0218')}</div>
                        <div className="layui-layer-content">{t('auto.k0219')}</div>
                        <span className="layui-layer-setwin" onClick={() => setIsModalOpen(false)}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={() => {
                                dealCommandSend();
                                setIsModalOpen(false);
                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                </Html>
            </Fragment>
            }
            {backBtn &&
                <Fragment key='0003'>
                    <Html>
                        <Close className="closeBtn" onClick={() => { setbackBtn(false); }} />
                        {backBtn && clickEvnt[0]['link'] && <iframe
                            title="Myiframe"
                            src={clickEvnt[0]['link']}
                            width={((wwidth / wscale)) + 'px'}
                            height={((wheight / wscale) - 5) + 'px'}
                            frameBorder="0"
                            allowFullScreen
                        ></iframe>}
                        {backBtn && (clickEvnt[0]['weblink'] || clickEvnt[0]['pagekey']) && <iframe
                            title="Myiframe"
                            src={dealweblink}
                            width={((wwidth / wscale)) + 'px'}
                            height={((wheight / wscale) - 5) + 'px'}
                            frameBorder="0"
                            allowFullScreen
                        ></iframe>}
                    </Html>
                </Fragment>
            }
            {isVideoModalOpen && <Fragment key='0004'>
                <Html>
                    <div className="layui-layer" style={isVideoModalOpen ? { 'display': 'block', 'width': (500 / wscale) + 'px', 'height': ((380 / wscale)) + 'px', 'left': 'calc(50vw - ' + (250 / wscale) + 'px)', 'top': 'calc(50vh - ' + (190 / wscale) + 'px)' } : { 'display': 'none' }}>
                        <div className="layui-layer-title" style={{ 'paddingRight': '10px' }}>
                            {t('auto.k0389')}
                            {/* <Close className="closeVideoBtn" onClick={() => { handleVideoCancel(); }} style={{ 'color': '#333'}}/> */}
                        </div>
                        <span className="layui-layer-setwin" onClick={() => { handleVideoCancel(); }} style={{ 'color': '#333' }}>
                            <Close />
                        </span>
                        <iframe
                            title="Myiframe"
                            src={dealVideo}
                            width={((500 / wscale) - 0.5) + 'px'}
                            height={((350 / wscale) - 1) + 'px'}
                            frameBorder="0"
                            allowFullScreen
                        ></iframe>
                    </div>
                </Html>
            </Fragment>
            }
        </Fragment>
    );
};

export default PreviewElement;
