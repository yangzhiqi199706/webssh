import React, { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import { Stage, Layer, Rect, Transformer, Text, Group, Line } from "react-konva";
import httpsend from '../Assets/httpsend';
import ToolList from "./ToolList";
import ItemBox from "./ItemBox";
import ConElement from "./ConElement";
import ElementAttr from "./ElementAttr";
import ElementSvg from "./ElementSvg";
import SvgBackground from "./SvgBackground";
import { Select, message, Button, Cascader } from 'antd';
import setChart from "./SetChart";
import { Close } from '@mui/icons-material';
import PreviewElement from "./PreviewElement";
import PreviewDeal from "./PreviewDeal";
import { buildMainApiUrl } from '../config/endpoints';
import { t } from '../i18n';

import Konva from "konva";

let history = [];
const PAGE_DESIGNER_CLIPBOARD_KEY = 'page_designer_clipboard_v1';
const SNAP_GUIDE_OFFSET = 24;
const params = new URLSearchParams(window.location.search);
const isPreview = params.get('type') ? true : false;// Comment translated to English.
const isSwiper = params.get('swiper') ? true : false;// Comment translated to English.
const txttitle = params.get('title') || '';// Comment translated to English.
let stagejson = '';// Comment translated to English.

// Comment translated to English.
const loginState = localStorage.getItem('wl') || null;
if (!loginState && !isPreview) {
    message.error(t('auto.k0333'), 2, function () {
        window.location.href = httpsend.mainURL() + 'login.html';
    });
} else if (loginState && !isPreview) {
    // checkToken();
}

const normalizeStageSize = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.round(parsed);
};

function Home() {
    const stageRef = useRef();
    const containerRef = useRef();
    const previewDataRef = useRef(null);

    // Comment translated to English.
    const [dragUrl, setDragUrl] = useState();
    const [dragAttrs, setDragAttrs] = useState(null);
    const [dragShape, setDragShape] = useState(null);
    // Comment translated to English.
    const [images, setImages] = useState([]);
    const imagesRef = useRef(images);
    // Comment translated to English.
    const [selectedId, setSelectedId] = useState(null);
    const selectedIdRef = useRef(selectedId);
    // Comment translated to English.
    const [selectedIds, selectShapes] = useState([]);
    const selectedIdsRef = useRef(selectedIds);
    const [marqueeHoverIds, setMarqueeHoverIds] = useState([]);
    const [hoverElementIds, setHoverElementIds] = useState([]);
    const layerRef = useRef();
    const transformRefids = useRef();
    // Comment translated to English.
    const selectionRectRef = useRef();
    const selection = useRef({
        visible: false,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0
    });
    const oldPos = useRef(null);
    // Comment translated to English.
    const [toolType, settoolType] = useState(null);
    // Comment translated to English.
    const [showIndex, setshowIndex] = useState(1);// Comment translated to English.
    // Comment translated to English.
    const [backgroundImage, setBackgroundImage] = useState();

    const [alarmCatch, setalarmCatch] = useState('1');
    const alarmCatchRef = useRef(alarmCatch);

    // Comment translated to English.
    const [showsaveTplBox, setshowsaveTplBox] = useState(0);
    const [saveTplName, setsaveTplName] = useState();
    // Comment translated to English.
    const [savePagePidSel, setsavePagePidSel] = useState();// Comment translated to English.
    const [showsavePageBox, setshowsavePageBox] = useState(0);
    // Comment translated to English.
    const [savePageType, setsavePageType] = useState();// Comment translated to English.
    const [savePagePid, setsavePagePid] = useState();// Comment translated to English.
    const [savePageName, setsavePageName] = useState();// Comment translated to English.
    const [savePageTxt, setsavePageTxt] = useState();// Comment translated to English.
    const [savePageIndex, setsavePageIndex] = useState();// Comment translated to English.
    const [savePageLink, setsavePageLink] = useState();// Comment translated to English.
    const [savePageId, setsavePageId] = useState('0');// Comment translated to English.
    const [isModalOpen, setIsModalOpen] = useState(false);// Comment translated to English.
    const [editModalOpen, seteditModalOpen] = useState(false);// Comment translated to English.
    // Comment translated to English.
    const [imagesstatic, setImagesstatic] = useState([]);
    const [imagesdata, setImagesdata] = useState([]);
    // Comment translated to English.
    const [isOutOpen, setIsOutOpen] = useState(false);
    // Comment translated to English.
    const [resetBox, setresetBox] = useState(false);
    const [pagedevList, setpagedevList] = useState([]);// Comment translated to English.
    // Comment translated to English.
    const [stageWidth, setstageWidth] = useState(1920);
    const stageWidthRef = useRef(stageWidth);
    const [stageHeight, setstageHeight] = useState(1080);
    const stageHeightRef = useRef(stageHeight);
    const safeStageWidth = normalizeStageSize(stageWidth, 1920);
    const safeStageHeight = normalizeStageSize(stageHeight, 1080);
    // Comment translated to English.
    const [canvasScale, setcanvasScale] = useState(100);

    const [saveStatusText, setSaveStatusText] = useState('已保存');
    const [lastAutoSaveTime, setLastAutoSaveTime] = useState('');
    const lastSavedStageJsonRef = useRef('');
    const saveStatusTimerRef = useRef(null);
    // F11b 精简版：5 分钟空闲自动保存
    const dirtyRef = useRef(false);            // 有未保存修改时为 true
    const autoSaveTimerRef = useRef(null);     // 5 分钟自动保存定时器
    // 页面加载令牌：每次 dealStringPage / newPage 切换页面时换一个新值，
    // 用于跨页面复制粘贴时判断是否同一页面（草稿页 savePageId 都是 '0' 无法区分）
    const currentPageTokenRef = useRef('init-' + Date.now());
    const [tabFlash, setTabFlash] = useState('');
    const [hoverHighlightIds, setHoverHighlightIds] = useState([]);

    const formatTime = (date = new Date()) => {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    };

    const setSavedStatus = (text = '已保存') => {
        if (saveStatusTimerRef.current) {
            clearTimeout(saveStatusTimerRef.current);
            saveStatusTimerRef.current = null;
        }
        setSaveStatusText(text);
        if (text === '已自动保存') {
            setLastAutoSaveTime(formatTime());
        } else if (text === '已保存') {
            setLastAutoSaveTime('');
        }
        if (text !== '已修改') {
            saveStatusTimerRef.current = setTimeout(() => {
                setSaveStatusText('已保存');
                saveStatusTimerRef.current = null;
            }, 1800);
        }
    };

    // F11b 精简版：把当前 Stage 序列化成保存用的 JSON（沿用 savePage 的处理逻辑）
    const buildPageJson = () => {
        if (!stageRef.current) return '';
        // 关键：序列化前先把 Konva 节点真实位置同步回 imagesRef，确保自动保存写入的 x/y
        // 永远等于视觉看到的位置，避免 5 分钟空闲自动保存把旧 imagesRef 的偏差固化到 chart
        if (typeof syncKonvaPositionsToImagesRef === 'function') {
            syncKonvaPositionsToImagesRef();
        }
        let raw = stageRef.current.toJSON();
        let newjson;
        try {
            newjson = JSON.parse(raw);
        } catch (e) {
            return '';
        }
        const shapeMap = {};
        imagesRef.current.forEach((shape) => {
            shapeMap[shape.id] = shape;
        });
        if (newjson && newjson.children && newjson.children[0] && Array.isArray(newjson.children[0].children)) {
            newjson.children[0].children.forEach(element => {
                if (element.attrs.id === 'canvasBackground') {
                    if (backgroundImage && backgroundImage.indexOf('#') === -1) {
                        if (backgroundImage.indexOf('/public/') > 0) {
                            element.attrs.fillPatternImage = backgroundImage.split('/public/')[1];
                        } else {
                            element.attrs.fillPatternImage = backgroundImage;
                        }
                    }
                    element.attrs.alarmCatch = alarmCatchRef.current;
                    return;
                }
                const currentShape = shapeMap[element.attrs.id];
                if (currentShape) {
                    element.attrs = JSON.parse(JSON.stringify(currentShape));
                }
            });
        }
        return JSON.stringify(newjson);
    };

    // F11b 精简版：仅静默回写"已经存在的页面"，永远不主动新建草稿页
    const silentAutoSave = async () => {
        if (isPreview) return;
        if (!dirtyRef.current) return;             // 没改动就跳过
        if (!savePageId || savePageId === '0') return;   // 草稿页（未新建过）跳过
        if (savePageType !== '1' || !savePageTxt) return; // 只保存 PageType=1 的常规页面
        const savejson = buildPageJson();
        if (!savejson) return;
        try {
            const res = await httpsend.getData('ChangeDmpageKey', { id: savePageId });
            if (!res || res.code !== 100) return;
            const res2 = await httpsend.getDataLocal('savePage', { name: savePageTxt, pagecon: savejson });
            if (!res2 || res2.code !== 100) return;
            dirtyRef.current = false;
            lastSavedStageJsonRef.current = savejson;
            setSavedStatus('已自动保存');
        } catch (e) {
            // 静默失败：等下一次 dirty + 5 分钟后再尝试
        }
    };

    // F11b 精简版：每次有修改都重置 5 分钟定时器（停止操作 5 分钟才触发自动保存）
    const scheduleAutoSave = () => {
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }
        if (isPreview) return;
        autoSaveTimerRef.current = setTimeout(() => {
            autoSaveTimerRef.current = null;
            silentAutoSave();
        }, 5 * 60 * 1000);
    };

    // 取消自动保存（用于手动保存后 / 切换页面 / unmount）
    const cancelAutoSave = () => {
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }
    };

    // F11b 精简版：刚加载完一个页面，等 React 把 setImages/setBackgroundImage 引起的 useEffect 跑完后回滚 dirty 状态
    const markPageLoaded = () => {
        setTimeout(() => {
            dirtyRef.current = false;
            cancelAutoSave();
            if (saveStatusTimerRef.current) {
                clearTimeout(saveStatusTimerRef.current);
                saveStatusTimerRef.current = null;
            }
            setSaveStatusText('已保存');
            setLastAutoSaveTime('');
        }, 0);
    };

    useEffect(() => {
        // 关闭网页 / 刷新 / 跳转外部链接前，如果还有未保存改动则弹原生提示
        // 注意：现代浏览器出于安全考虑只显示固定文案（"离开此页面? / 系统可能不会保存您所做的更改"），
        // returnValue 的字符串内容不会被使用，但必须设置才能触发对话框。
        // Chrome / Edge / Firefox 都要求 preventDefault() + returnValue 双重保险。
        // 关键：用 ref 读取最新的 savePageId / savePageType / savePageTxt，避免 useEffect [] 闭包陈旧
        // 导致切到新页面后改东西关网页不弹提示。
        const handleBeforeUnload = (e) => {
            if (isPreview) return;                                                     // 预览模式不拦截
            if (!dirtyRef.current) return;                                             // 没有未保存改动不拦截
            const curPageId = savePageIdRef.current;
            const curPageType = savePageTypeRef.current;
            const curPageTxt = savePageTxtRef.current;
            if (!curPageId || curPageId === '0') return;                               // 草稿页未新建过不拦截
            if (curPageType !== '1' || !curPageTxt) return;                            // 非 PageType=1 不拦截
            e.preventDefault();
            e.returnValue = '页面有未保存的修改，确定要离开吗？';
            return e.returnValue;
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            if (saveStatusTimerRef.current) {
                clearTimeout(saveStatusTimerRef.current);
            }
            if (autoSaveTimerRef.current) {
                clearTimeout(autoSaveTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!savePageId || savePageId === '0') return;
        setshowIndex(1);
        setTabFlash('component');
        const timer = setTimeout(() => {
            setTabFlash('');
        }, 650);
        return () => clearTimeout(timer);
    }, [savePageId]);

    const initialImagesSnapshotRef = useRef(false);
    const saveStatusTextRef = useRef('已保存');
    // 用 ref 跟踪 savePageId / savePageType / savePageTxt 的最新值，
    // 让 useEffect [] 内的 beforeunload 监听不会被初始挂载时的闭包冻结
    const savePageIdRef = useRef(savePageId);
    const savePageTypeRef = useRef(savePageType);
    const savePageTxtRef = useRef(savePageTxt);
    useEffect(() => { savePageIdRef.current = savePageId; }, [savePageId]);
    useEffect(() => { savePageTypeRef.current = savePageType; }, [savePageType]);
    useEffect(() => { savePageTxtRef.current = savePageTxt; }, [savePageTxt]);
    useEffect(() => {
        saveStatusTextRef.current = saveStatusText;
    }, [saveStatusText]);
    useEffect(() => {
        if (!initialImagesSnapshotRef.current) {
            initialImagesSnapshotRef.current = true;
            return;
        }
        // F11b 精简版：用户做了改动 → 标 dirty + 启动/重置 5 分钟定时器
        dirtyRef.current = true;
        scheduleAutoSave();
        if (saveStatusTextRef.current !== '已修改') {
            if (saveStatusTimerRef.current) {
                clearTimeout(saveStatusTimerRef.current);
                saveStatusTimerRef.current = null;
            }
            setSaveStatusText('已修改');
        }
    }, [images, backgroundImage]);

    // Comment translated to English.
    const getevData = async (callback) => {
        let res = await httpsend.getData('GetDeviceListKey', {
            ComboBox: "all"
        });
        let devList = [];
        if (res) {
            res.data.forEach((val, n) => {
                devList.push({
                    value: val.id,
                    label: val.DeviceName,
                    code: val.ProtocolCode,
                    codeName: val.ProtocolName,
                    onlyCode: val.OnlyCode,// Comment translated to English.
                })
            })
            callback(devList)
        }
    }
    useEffect(() => {
        if (resetBox) {
            getevData(function (devList) {
                let pagedev = [];
                imagesRef.current.forEach(shapeProps => {
                    if (shapeProps.moduleJson && shapeProps.moduleJson.attrs.dataKey) {
                        let dataKey = shapeProps.moduleJson.attrs.dataKey;
                        if (dataKey && dataKey.length === 1) {// Comment translated to English.
                            dataKey.forEach((el) => {
                                // Comment translated to English.
                                if (el.key || el.deveventskey) {
                                    const currentKey = el.key || el.deveventskey;
                                    const currentKeyStr = String(currentKey);
                                    // Comment translated to English.
                                    let findpagedevindex = pagedev.findIndex(v => String(v.value) === currentKeyStr)
                                    if (findpagedevindex === -1) {
                                        // Comment translated to English.
                                        // Comment translated to English.
                                        let finddevindex = devList.findIndex(v => String(v.value) === currentKeyStr)
                                        if (finddevindex === -1) {
                                            // Comment translated to English.
                                            let finddevonlyindex = devList.findIndex(v => String(v.onlyCode) === currentKeyStr)
                                            if (finddevonlyindex !== -1) {
                                                pagedev.push({
                                                    value: devList[finddevonlyindex]['onlyCode'],
                                                    label: devList[finddevonlyindex]['label'],
                                                    code: devList[finddevonlyindex]['code'],
                                                    codeName: devList[finddevonlyindex]['codeName'],
                                                    // children: devList.filter(v => (v.codeName === devList[finddevindex]['codeName']))
                                                    children: devList
                                                })
                                            }
                                        } else {
                                            pagedev.push({
                                                value: currentKey,
                                                label: devList[finddevindex]['label'],
                                                code: devList[finddevindex]['code'],
                                                codeName: devList[finddevindex]['codeName'],
                                                // children: devList.filter(v => (v.codeName === devList[finddevindex]['codeName']))
                                                // children: devList.filter(v => (v.value !== devList[finddevindex]['value']))
                                                children: devList
                                            })
                                        }
                                    }
                                }
                            })
                        }
                    }
                })
                // console.log(pagedev)
                setpagedevList(pagedev);
            });
        } else {
            setpagedevList([]);// Comment translated to English.
        }
    }, [resetBox]);
    const ondataDevOptionSearch = (value) => { };
    const filterOption = (input, option) => (option && option.label).toLowerCase().includes(input.toLowerCase());
    // Comment translated to English.
    // Comment translated to English.
    // const [showUrlBox, setshowUrlBox] = useState(false);
    // const [showUrl, setshowUrl] = useState();

    // Comment translated to English.
    // const stageWidth = window.innerWidth,
    //     stageHeight = window.innerHeight;
    // const stageWidth = 1920,//1730
    //     stageHeight = 1080;//829

    // Comment translated to English.
    const [stageDimensions, setStageDimensions] = useState({
        width: stageWidth,
        height: stageHeight,
        scalex: 1,
        scaley: 1
    });

    const getBoundedDragPosition = (metrics, x, y) => {
        if (!metrics) {
            return { x, y };
        }
        const maxX = Math.max(0, stageWidth - metrics.width);
        const maxY = Math.max(0, stageHeight - metrics.height);
        return {
            x: Math.min(Math.max(0, x), maxX),
            y: Math.min(Math.max(0, y), maxY),
        };
    };

    const getBoundedTransformerBox = (oldBox, newBox) => {
        if (!newBox) return oldBox;
        if (newBox.width < 5 || newBox.height < 5) {
            return oldBox;
        }
        let nextBox = { ...newBox };
        if (nextBox.x < 0) {
            nextBox.width += nextBox.x;
            nextBox.x = 0;
        }
        if (nextBox.y < 0) {
            nextBox.height += nextBox.y;
            nextBox.y = 0;
        }
        if (nextBox.x + nextBox.width > stageWidth) {
            nextBox.width = stageWidth - nextBox.x;
        }
        if (nextBox.y + nextBox.height > stageHeight) {
            nextBox.height = stageHeight - nextBox.y;
        }
        if (nextBox.width < 5 || nextBox.height < 5) {
            return oldBox;
        }
        return nextBox;
    };

    // F6 多选拖动：跟随移动 / 提交 / 框选扩展（F7 时增强为组合扩展）
    const multiDragRef = useRef({
        active: false,
        draggedId: null,
        startPositions: {},
        pendingPositions: null,
    });
    // 多选/组合拖动 dragend 阶段，Konva 会让所有 nodes 各触发一次 onChange：
    //   - 被拖元素 (draggedId) 走 commitMultiDragPositions（push 1 次 history）
    //   - 其余跟随成员若也走 handleShapeChange 又会各 push 1 次 history → 撤销要按 N 次
    // 用这个 ref 在 dragstart 时记录"非被拖的跟随成员 id"，dragend 时这些 id 的 onChange 直接 return 并自移除
    const pendingDragFollowerIdsRef = useRef(new Set());

    // F7 组合：基于 shape.groupId 维护逻辑组
    const getShapeGroupId = (shapeOrId) => {
        const shape = typeof shapeOrId === 'string'
            ? imagesRef.current.find((item) => item.id === shapeOrId)
            : shapeOrId;
        return shape && shape.groupId ? shape.groupId : '';
    };

    const getGroupMemberIds = (groupId) => {
        if (!groupId) return [];
        return imagesRef.current.filter((item) => item.groupId === groupId).map((item) => item.id);
    };

    const getExpandedSelectionIds = (shapeOrId) => {
        const shape = typeof shapeOrId === 'string'
            ? imagesRef.current.find((item) => item.id === shapeOrId)
            : shapeOrId;
        if (!shape) return [];
        if (!shape.groupId) return [shape.id];
        const memberIds = getGroupMemberIds(shape.groupId);
        return memberIds.length > 0 ? memberIds : [shape.id];
    };

    const createDerivedGroupId = (sourceGroupId) => {
        if (!sourceGroupId) return null;
        return `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    };

    // 组合扩展：拖动 / 选择某成员时把同组成员一并纳入（排除锁定元素）
    const expandDragSelectionIds = (ids, draggedShapeId) => {
        const result = new Set();
        const baseIds = Array.isArray(ids) ? ids : [];
        const mergedIds = [...new Set([...(draggedShapeId ? [draggedShapeId] : []), ...baseIds])];
        mergedIds.forEach((id) => {
            getUnlockedExpandedSelectionIds(id).forEach((memberId) => result.add(memberId));
        });
        return Array.from(result);
    };

    const groupSelectedShapes = () => {
        if (!Array.isArray(selectedIdsRef.current) || selectedIdsRef.current.length < 2) return;
        const groupId = `group_${Date.now()}`;
        const nextImages = imagesRef.current.map((shape) => (
            selectedIdsRef.current.includes(shape.id)
                ? { ...shape, groupId }
                : shape
        ));
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
    };

    const isSelectionSingleGroup = () => {
        if (!Array.isArray(selectedIdsRef.current) || selectedIdsRef.current.length === 0) return false;
        const groupIds = [...new Set(selectedIdsRef.current.map((id) => getShapeGroupId(id)).filter(Boolean))];
        return groupIds.length === 1 && selectedIdsRef.current.every((id) => getShapeGroupId(id) === groupIds[0]);
    };

    const ungroupSelectedShapes = () => {
        if (!isSelectionSingleGroup()) return;
        const groupId = getShapeGroupId(selectedIdsRef.current[0]);
        const memberIds = getGroupMemberIds(groupId);
        const nextImages = imagesRef.current.map((shape) => (
            memberIds.includes(shape.id)
                ? { ...shape, groupId: null }
                : shape
        ));
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        selectShapes(memberIds);
        selectedIdsRef.current = memberIds;
    };

    // F2 锁定保护：基于 shape.draggable === false 标记锁定
    const isShapeUnlocked = (shapeOrId) => {
        const shape = typeof shapeOrId === 'string'
            ? imagesRef.current.find((item) => item.id === shapeOrId)
            : shapeOrId;
        return !!(shape && shape.draggable !== false);
    };

    const getUnlockedSelectedIds = () => {
        if (!Array.isArray(selectedIdsRef.current) || selectedIdsRef.current.length === 0) return [];
        return selectedIdsRef.current.filter((id) => isShapeUnlocked(id));
    };

    const getUnlockedExpandedSelectionIds = (shapeOrId) => {
        return getExpandedSelectionIds(shapeOrId).filter((id) => isShapeUnlocked(id));
    };

    const lockSelectedShapes = () => {
        const unlockedSelectedIds = getUnlockedSelectedIds();
        const targetIds = unlockedSelectedIds.length > 0
            ? unlockedSelectedIds
            : (selectedIdRef.current !== null && isShapeUnlocked(selectedIdRef.current) ? [selectedIdRef.current] : []);
        if (targetIds.length === 0) return;
        const nextImages = imagesRef.current.map((shape) => (
            targetIds.includes(shape.id) ? { ...shape, draggable: false } : shape
        ));
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        selectShapes([]);
        selectedIdsRef.current = [];
        setSelectedId(null);
        selectedIdRef.current = null;
        setDragShape(null);
    };

    const unlockSelectedShapes = () => {
        let lockedSelectedIds = [];
        if (Array.isArray(selectedIdsRef.current) && selectedIdsRef.current.length > 0) {
            lockedSelectedIds = selectedIdsRef.current.filter((id) => !isShapeUnlocked(id));
        } else if (selectedIdRef.current !== null && !isShapeUnlocked(selectedIdRef.current)) {
            lockedSelectedIds = [selectedIdRef.current];
        } else {
            lockedSelectedIds = imagesRef.current.filter((shape) => shape.draggable === false).map((shape) => shape.id);
        }
        if (lockedSelectedIds.length === 0) return;
        const nextImages = imagesRef.current.map((shape) => (
            lockedSelectedIds.includes(shape.id) ? { ...shape, draggable: true } : shape
        ));
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        selectShapes([]);
        selectedIdsRef.current = [];
        setSelectedId(null);
        selectedIdRef.current = null;
        setDragShape(null);
    };

    const canGroupSelection = selectedIds.length >= 2;
    const canUngroupSelection = isSelectionSingleGroup();

    // 对齐锚点：用户最先选中的元素 / 组合，对齐时锚点不动，其他 unit 向锚点靠拢。
    // - 单选 / 0 选：无锚点（空集），UI 不画紫色高亮
    // - 多选：selectedIds[0] 所在的整个 group（若无 groupId 则就这一个 id）
    const alignmentAnchorIds = useMemo(() => {
        if (!Array.isArray(selectedIds) || selectedIds.length < 2) return [];
        const anchorId = selectedIds[0];
        if (!anchorId) return [];
        const anchorShape = imagesRef.current.find((s) => s.id === anchorId);
        if (!anchorShape) return [];
        const anchorGroupId = getShapeGroupId(anchorShape);
        if (anchorGroupId) {
            // 整组都算锚点：锁定成员也涂紫，便于用户直观看到哪个 unit 不会动
            return selectedIds.filter((id) => getShapeGroupId(id) === anchorGroupId);
        }
        return [anchorId];
    }, [selectedIds, images]);

    // F13 界面结构树 + hover 高亮
    const getStructureItemLabel = (shape, index = 0) => {
        if (!shape || !shape.moduleJson) return `元素 ${index + 1}`;
        const firstChild = shape.moduleJson.children && shape.moduleJson.children[0] ? shape.moduleJson.children[0] : null;
        const attrs = firstChild && firstChild.attrs ? firstChild.attrs : {};
        return attrs.text || attrs.name || (firstChild && firstChild.className) || `元素 ${index + 1}`;
    };

    const getInterfaceStructure = () => {
        const groupMap = {};
        const singles = [];
        images.forEach((shape, index) => {
            const item = {
                id: shape.id,
                label: getStructureItemLabel(shape, index),
                groupId: shape.groupId || '',
            };
            if (shape.groupId) {
                if (!groupMap[shape.groupId]) {
                    groupMap[shape.groupId] = {
                        groupId: shape.groupId,
                        label: `组合 ${Object.keys(groupMap).length + 1}`,
                        members: [],
                    };
                }
                groupMap[shape.groupId].members.push(item);
            } else {
                singles.push(item);
            }
        });
        return { singles, groups: Object.values(groupMap) };
    };

    const selectStructureTarget = (shapeId, useGroupSelection = true) => {
        const shape = imagesRef.current.find((item) => item.id === shapeId);
        if (!shape) return;
        const targetIds = useGroupSelection ? getExpandedSelectionIds(shapeId) : [shapeId];
        if (targetIds.length > 1) {
            selectShapes(targetIds);
            selectedIdsRef.current = targetIds;
        } else {
            selectShapes([]);
            selectedIdsRef.current = [];
        }
        setSelectedId(shapeId);
        selectedIdRef.current = shapeId;
        setDragShape(shape);
    };

    const scrollToStructureTarget = (shapeId, useGroupSelection = true) => {
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        const scroller = containerRef.current ? containerRef.current.querySelector('.canvasStage') : null;
        if (!stage || !scroller) return;
        const targetIds = useGroupSelection ? getExpandedSelectionIds(shapeId) : [shapeId];
        const rects = targetIds
            .map((id) => stage.findOne('#' + id))
            .filter(Boolean)
            .map((node) => node.getClientRect());
        if (rects.length === 0) return;
        const left = Math.min(...rects.map((rect) => rect.x));
        const top = Math.min(...rects.map((rect) => rect.y));
        const right = Math.max(...rects.map((rect) => rect.x + rect.width));
        const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
        const padding = 40;
        const targetScrollLeft = Math.max(0, left - padding);
        const targetScrollTop = Math.max(0, top - padding);
        if (left < scroller.scrollLeft || right > scroller.scrollLeft + scroller.clientWidth) {
            scroller.scrollLeft = targetScrollLeft;
        }
        if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
            scroller.scrollTop = targetScrollTop;
        }
    };

    const handleStructureItemClick = (shapeId, useGroupSelection = true) => {
        if (!shapeId) return;
        selectStructureTarget(shapeId, useGroupSelection);
        scrollToStructureTarget(shapeId, useGroupSelection);
        setshowIndex(1);
        setTabFlash('component');
        setTimeout(() => setTabFlash(''), 650);
    };

    // F8 剪贴板：copy / cut / paste（精简版：尚未引入锁定保护）
    const getClipboardSelectionShapes = () => {
        let targetIds = [];
        if (Array.isArray(selectedIdsRef.current) && selectedIdsRef.current.length > 0) {
            targetIds = expandDragSelectionIds(selectedIdsRef.current, null);
        } else if (selectedIdRef.current !== null) {
            targetIds = getExpandedSelectionIds(selectedIdRef.current);
        }
        if (!Array.isArray(targetIds) || targetIds.length === 0) return [];
        return imagesRef.current.filter((shape) => targetIds.includes(shape.id));
    };

    const writeClipboard = (shapes) => {
        const payload = {
            type: 'page-elements',
            copiedAt: Date.now(),
            sourcePageId: savePageId,
            sourcePageToken: currentPageTokenRef.current,  // 即使 savePageId 都是 '0'，token 也能区分草稿页
            elements: JSON.parse(JSON.stringify(shapes || [])),
        };
        try { localStorage.setItem(PAGE_DESIGNER_CLIPBOARD_KEY, JSON.stringify(payload)); } catch (e) { }
    };

    const readClipboard = () => {
        try {
            const raw = localStorage.getItem(PAGE_DESIGNER_CLIPBOARD_KEY);
            if (!raw) return null;
            const payload = JSON.parse(raw);
            if (!payload || payload.type !== 'page-elements' || !Array.isArray(payload.elements)) return null;
            return payload;
        } catch (error) {
            return null;
        }
    };

    // 简单 bounds：F1 落位后会换成基于 Konva node 的 metrics
    const getClipboardBoundsSimple = (elements) => {
        if (!Array.isArray(elements) || elements.length === 0) return null;
        const xs = []; const ys = []; const xs2 = []; const ys2 = [];
        elements.forEach((s) => {
            const x = Number(s.x || 0);
            const y = Number(s.y || 0);
            const w = Number((s.moduleJson && s.moduleJson.width) || s.width || 0);
            const h = Number((s.moduleJson && s.moduleJson.height) || s.height || 0);
            xs.push(x); ys.push(y); xs2.push(x + w); ys2.push(y + h);
        });
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const right = Math.max(...xs2);
        const bottom = Math.max(...ys2);
        return { left, top, right, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
    };

    const getViewportCenterOnCanvas = () => {
        const scroller = containerRef.current ? containerRef.current.querySelector('.canvasStage') : null;
        if (!scroller) return { x: stageWidth / 2, y: stageHeight / 2 };
        const scrollLeft = scroller.scrollLeft || 0;
        const scrollTop = scroller.scrollTop || 0;
        const centerX = (scrollLeft + scroller.clientWidth / 2) / (stageDimensions.scalex || 1);
        const centerY = (scrollTop + scroller.clientHeight / 2) / (stageDimensions.scaley || 1);
        return { x: centerX, y: centerY };
    };

    const copySelectionToClipboard = () => {
        // 关键：先把 Konva 节点的真实位置同步回 imagesRef，避免拖动 / 浮点累积偏差导致复制体相对位置错乱
        syncKonvaPositionsToImagesRef();
        const selectionShapes = getClipboardSelectionShapes();
        if (selectionShapes.length === 0) {
            message.warning('当前没有可复制的元素');
            return;
        }
        writeClipboard(selectionShapes);
        message.success(`已复制 ${selectionShapes.length} 个元素`);
    };

    const cutSelectionToClipboard = () => {
        // 关键：先把 Konva 节点的真实位置同步回 imagesRef，避免剪切后粘贴位置错乱
        syncKonvaPositionsToImagesRef();
        const selectionShapes = getClipboardSelectionShapes();
        if (selectionShapes.length === 0) return;
        writeClipboard(selectionShapes);
        const deleteIds = new Set(selectionShapes.map((shape) => shape.id));
        const nextImages = imagesRef.current.filter((shape) => !deleteIds.has(shape.id));
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        selectShapes([]);
        selectedIdsRef.current = [];
        setSelectedId(null);
        selectedIdRef.current = null;
        setDragShape(null);
        settoolType(null);
        message.success(`已剪切 ${selectionShapes.length} 个元素`);
    };

    const pasteClipboardSelection = () => {
        const payload = readClipboard();
        if (!payload || !payload.elements || payload.elements.length === 0) {
            message.warning('暂无可粘贴内容');
            return;
        }
        const groupIdMap = {};
        const pastedIds = [];
        const nextImages = JSON.parse(JSON.stringify(imagesRef.current));
        const clipboardBounds = getClipboardBoundsSimple(payload.elements);
        const viewportCenter = getViewportCenterOnCanvas();
        // 跨页面粘贴时保持原始位置（不偏移），同页面内粘贴才偏移到视口中心
        // 优先用 token 判（草稿页 savePageId 都是 '0' 无法区分），fallback 到 savePageId
        let isCrossPagePaste = false;
        if (payload.sourcePageToken && payload.sourcePageToken !== currentPageTokenRef.current) {
            isCrossPagePaste = true;
        } else if (!payload.sourcePageToken && payload.sourcePageId && String(payload.sourcePageId) !== String(savePageId)) {
            // 兼容旧的 localStorage 数据（没有 token）
            isCrossPagePaste = true;
        }
        const offsetX = isCrossPagePaste ? 0 : (clipboardBounds ? (viewportCenter.x - clipboardBounds.centerX + 8) : 8);
        const offsetY = isCrossPagePaste ? 0 : (clipboardBounds ? (viewportCenter.y - clipboardBounds.centerY + 8) : 8);

        payload.elements.forEach((shape, index) => {
            const newId = `${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`;
            let nextGroupId = shape.groupId || null;
            if (shape.groupId) {
                if (!groupIdMap[shape.groupId]) {
                    groupIdMap[shape.groupId] = createDerivedGroupId(shape.groupId);
                }
                nextGroupId = groupIdMap[shape.groupId];
            }
            const nextShape = {
                ...shape,
                id: newId,
                x: Number(shape.x || 0) + offsetX,
                y: Number(shape.y || 0) + offsetY,
                groupId: nextGroupId,
            };
            pastedIds.push(newId);
            nextImages.push(nextShape);
        });

        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        selectShapes(pastedIds);
        selectedIdsRef.current = pastedIds;
        if (pastedIds.length > 0) {
            setSelectedId(pastedIds[0]);
            selectedIdRef.current = pastedIds[0];
            const pastedShape = nextImages.find((shape) => shape.id === pastedIds[0]);
            setDragShape(pastedShape || null);
        }
        message.success(`已粘贴 ${pastedIds.length} 个元素`);
    };

    // F1 磁吸 + 参考线
    const [snapEnabled, setSnapEnabled] = useState(true);
    const [snapThreshold, setSnapThreshold] = useState(6);
    // 引导线用 Konva 节点 ref + imperative 更新（避免 setState 触发 React 重渲染把多选拖动的 Konva 组员节点回拉）
    const snapGuideVRef = useRef(null);
    const snapGuideHRef = useRef(null);
    const updateSnapGuides = (guideData) => {
        const v = snapGuideVRef.current;
        const h = snapGuideHRef.current;
        if (v) {
            const g = guideData && guideData.vertical;
            if (g) {
                v.setAttrs({
                    visible: true,
                    points: [g.x, g.y1, g.x, g.y2],
                    stroke: g.isStageGuide ? '#fa8c16' : '#148cf1',
                    strokeWidth: g.isStageGuide ? 2 : 1,
                    dash: g.isStageGuide ? [10, 6] : [6, 4],
                    shadowColor: g.isStageGuide ? '#fa8c16' : '#148cf1',
                    shadowBlur: g.isStageGuide ? 4 : 2,
                });
            } else {
                v.setAttrs({ visible: false });
            }
            const layer = v.getLayer && v.getLayer();
            if (layer) layer.batchDraw();
        }
        if (h) {
            const g = guideData && guideData.horizontal;
            if (g) {
                h.setAttrs({
                    visible: true,
                    points: [g.x1, g.y, g.x2, g.y],
                    stroke: g.isStageGuide ? '#fa8c16' : '#148cf1',
                    strokeWidth: g.isStageGuide ? 2 : 1,
                    dash: g.isStageGuide ? [10, 6] : [6, 4],
                    shadowColor: g.isStageGuide ? '#fa8c16' : '#148cf1',
                    shadowBlur: g.isStageGuide ? 4 : 2,
                });
            } else {
                h.setAttrs({ visible: false });
            }
            const layer = h.getLayer && h.getLayer();
            if (layer) layer.batchDraw();
        }
    };
    const clearSnapGuides = () => updateSnapGuides(null);

    const getShapeRenderMetrics = (shape, stageNode) => {
        if (!shape || !shape.moduleJson || !shape.moduleJson.children || shape.moduleJson.children.length === 0) return null;
        const groupAttr = shape.moduleJson.children[0].attrs || {};
        const groupName = groupAttr.name;
        let width = shape.width || shape.moduleJson.width || 0;
        let height = shape.height || shape.moduleJson.height || 0;
        let borderWidth = Number(groupAttr.strokeWidth || 0);
        if (groupName === 'rectBackground' && shape.moduleJson.children[3] && shape.moduleJson.children[3].attrs) {
            const rectAttrs = shape.moduleJson.children[3].attrs;
            width = rectAttrs.width || width;
            height = rectAttrs.height || height;
            borderWidth = Number(rectAttrs.strokeWidth || borderWidth || 0);
        } else {
            if (groupAttr.width) width = groupAttr.width;
            if (groupAttr.height) height = groupAttr.height;
        }
        const scaleX = shape.scaleX || 1;
        const scaleY = shape.scaleY || 1;
        let actualWidth = width * scaleX;
        let actualHeight = height * scaleY;
        if (groupName === 'myShape' || groupName === 'buttonRect' || groupName === 'rectBackground') {
            actualWidth += borderWidth * scaleX;
            actualHeight += borderWidth * scaleY;
        }
        const x = Number(shape.x || 0);
        const y = Number(shape.y || 0);
        return {
            x, y,
            width: actualWidth, height: actualHeight,
            left: x, centerX: x + actualWidth / 2, right: x + actualWidth,
            top: y, centerY: y + actualHeight / 2, bottom: y + actualHeight,
        };
    };

    const buildStageGuideCandidates = () => ({
        vertical: [0, stageWidth / 2, stageWidth],
        horizontal: [0, stageHeight / 2, stageHeight],
    });

    const buildGroupMetricsFromIds = (ids, positionMap = null) => {
        if (!Array.isArray(ids) || ids.length === 0) return null;
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        const metricsList = ids.map((id) => {
            const shape = imagesRef.current.find((item) => item.id === id);
            if (!shape) return null;
            const stageNode = stage ? stage.findOne('#' + id) : null;
            const positionOverride = positionMap && positionMap[id] ? positionMap[id] : null;
            return getShapeRenderMetrics(
                positionOverride ? { ...shape, x: positionOverride.x, y: positionOverride.y } : shape,
                stageNode,
            );
        }).filter(Boolean);
        if (metricsList.length === 0) return null;
        const left = Math.min(...metricsList.map((item) => item.left));
        const top = Math.min(...metricsList.map((item) => item.top));
        const right = Math.max(...metricsList.map((item) => item.right));
        const bottom = Math.max(...metricsList.map((item) => item.bottom));
        return {
            x: left, y: top, left, top, right, bottom,
            width: right - left, height: bottom - top,
            centerX: left + (right - left) / 2, centerY: top + (bottom - top) / 2,
        };
    };

    // 把选中 ids 折成"对齐单元"列表：同 groupId 的成员合并成 1 个 unit（用整组外包盒），
    // 单 id 作为独立 unit。这样后续对齐按 unit 计算 offset，再把 offset 应用到 unit 内全部成员，
    // 组合就能作为整体参与对齐（成员相对位置保持不变）。
    const getAlignmentUnits = (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        const units = [];
        const visited = new Set();
        ids.forEach((id) => {
            if (visited.has(id)) return;
            const shape = imagesRef.current.find((item) => item.id === id);
            if (!shape) return;
            const groupId = getShapeGroupId(shape);
            if (groupId) {
                // 取选中 ids 中属于同一组的所有成员（不扩展未选成员，保持用户意图）
                const memberIds = ids.filter((selectedId) => getShapeGroupId(selectedId) === groupId);
                memberIds.forEach((memberId) => visited.add(memberId));
                const metrics = buildGroupMetricsFromIds(memberIds);
                if (metrics) {
                    units.push({ key: groupId, memberIds, metrics, isGroup: true });
                }
                return;
            }
            visited.add(id);
            const stageNode = stage ? stage.findOne('#' + id) : null;
            const metrics = getShapeRenderMetrics(shape, stageNode);
            if (metrics) {
                units.push({ key: id, memberIds: [id], metrics, isGroup: false });
            }
        });
        return units;
    };

    // 按 unit 粒度计算"水平等距 / 垂直等距"目标坐标
    const getDistributedUnitTargets = (units, axis) => {
        if (!Array.isArray(units) || units.length === 0) return {};
        if (units.length === 1) {
            return { [units[0].key]: axis === 'x' ? units[0].metrics.x : units[0].metrics.y };
        }
        const sortedUnits = [...units].sort((a, b) => (
            axis === 'x' ? a.metrics.x - b.metrics.x : a.metrics.y - b.metrics.y
        ));
        const firstUnit = sortedUnits[0];
        const lastUnit = sortedUnits[sortedUnits.length - 1];
        const start = axis === 'x' ? firstUnit.metrics.x : firstUnit.metrics.y;
        const end = axis === 'x'
            ? lastUnit.metrics.x + lastUnit.metrics.width
            : lastUnit.metrics.y + lastUnit.metrics.height;
        const totalSize = sortedUnits.reduce(
            (sum, unit) => sum + (axis === 'x' ? unit.metrics.width : unit.metrics.height),
            0,
        );
        const gap = sortedUnits.length > 1 ? (end - start - totalSize) / (sortedUnits.length - 1) : 0;
        const targets = {};
        let cursor = start;
        sortedUnits.forEach((unit) => {
            targets[unit.key] = cursor;
            cursor += (axis === 'x' ? unit.metrics.width : unit.metrics.height) + gap;
        });
        return targets;
    };

    const buildGuideCandidates = (excludeIds = []) => {
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        const excluded = new Set(excludeIds);
        const candidates = { vertical: [], horizontal: [] };
        imagesRef.current.forEach((shape) => {
            if (!shape || excluded.has(shape.id)) return;
            const stageNode = stage ? stage.findOne('#' + shape.id) : null;
            const metrics = getShapeRenderMetrics(shape, stageNode);
            if (!metrics) return;
            candidates.vertical.push({ value: metrics.left, top: metrics.top, bottom: metrics.bottom });
            candidates.vertical.push({ value: metrics.centerX, top: metrics.top, bottom: metrics.bottom });
            candidates.vertical.push({ value: metrics.right, top: metrics.top, bottom: metrics.bottom });
            candidates.horizontal.push({ value: metrics.top, left: metrics.left, right: metrics.right });
            candidates.horizontal.push({ value: metrics.centerY, left: metrics.left, right: metrics.right });
            candidates.horizontal.push({ value: metrics.bottom, left: metrics.left, right: metrics.right });
        });
        const stageGuides = buildStageGuideCandidates();
        stageGuides.vertical.forEach((value) => candidates.vertical.push({ value, top: 0, bottom: stageHeight }));
        stageGuides.horizontal.forEach((value) => candidates.horizontal.push({ value, left: 0, right: stageWidth }));
        return candidates;
    };

    const getBestSnapMatch = (edges, guideCandidates, axis) => {
        let bestMatch = null;
        edges.forEach((edge) => {
            guideCandidates.forEach((guide) => {
                const distance = Math.abs(edge.value - guide.value);
                if (distance > snapThreshold) return;
                if (!bestMatch || distance < bestMatch.distance) {
                    bestMatch = { axis, edge, guide, distance };
                }
            });
        });
        return bestMatch;
    };

    const getSnappedMetrics = (metrics, excludeIds = []) => {
        const candidates = buildGuideCandidates(excludeIds);
        const verticalEdges = [
            { type: 'left', value: metrics.left },
            { type: 'centerX', value: metrics.centerX },
            { type: 'right', value: metrics.right },
        ];
        const horizontalEdges = [
            { type: 'top', value: metrics.top },
            { type: 'centerY', value: metrics.centerY },
            { type: 'bottom', value: metrics.bottom },
        ];
        const matchX = getBestSnapMatch(verticalEdges, candidates.vertical, 'x');
        const matchY = getBestSnapMatch(horizontalEdges, candidates.horizontal, 'y');
        let snappedX = metrics.x;
        let snappedY = metrics.y;
        if (matchX) snappedX += matchX.guide.value - matchX.edge.value;
        if (matchY) snappedY += matchY.guide.value - matchY.edge.value;
        const nextMetrics = {
            ...metrics,
            x: snappedX, y: snappedY,
            left: snappedX, right: snappedX + metrics.width,
            top: snappedY, bottom: snappedY + metrics.height,
            centerX: snappedX + metrics.width / 2,
            centerY: snappedY + metrics.height / 2,
        };
        return { matchX, matchY, snappedMetrics: nextMetrics };
    };

    const buildSnapGuideLine = (snapX, snapY, metrics, matchX, matchY) => ({
        vertical: matchX ? {
            x: snapX,
            y1: Math.min(metrics.top, matchX.guide.top) - SNAP_GUIDE_OFFSET,
            y2: Math.max(metrics.bottom, matchX.guide.bottom) + SNAP_GUIDE_OFFSET,
            isStageGuide: matchX.guide.top === 0 && matchX.guide.bottom === stageHeight,
        } : null,
        horizontal: matchY ? {
            y: snapY,
            x1: Math.min(metrics.left, matchY.guide.left) - SNAP_GUIDE_OFFSET,
            x2: Math.max(metrics.right, matchY.guide.right) + SNAP_GUIDE_OFFSET,
            isStageGuide: matchY.guide.left === 0 && matchY.guide.right === stageWidth,
        } : null,
    });

    const applySnapForShape = (node, shape) => {
        if (!node || !shape) return;
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        const stageNode = stage ? stage.findOne('#' + shape.id) : null;
        const metrics = getShapeRenderMetrics({ ...shape, x: node.x(), y: node.y() }, stageNode || node);
        if (!metrics) return;
        if (!snapEnabled) {
            const boundedPosition = getBoundedDragPosition(metrics, metrics.x, metrics.y);
            node.position(boundedPosition);
            clearSnapGuides();
            return;
        }
        const { matchX, matchY, snappedMetrics } = getSnappedMetrics(metrics, [shape.id]);
        const boundedPosition = getBoundedDragPosition(snappedMetrics, snappedMetrics.x, snappedMetrics.y);
        const boundedMetrics = {
            ...snappedMetrics,
            x: boundedPosition.x, y: boundedPosition.y,
            left: boundedPosition.x, right: boundedPosition.x + snappedMetrics.width,
            top: boundedPosition.y, bottom: boundedPosition.y + snappedMetrics.height,
            centerX: boundedPosition.x + snappedMetrics.width / 2,
            centerY: boundedPosition.y + snappedMetrics.height / 2,
        };
        node.position({ x: boundedMetrics.x, y: boundedMetrics.y });
        if (matchX || matchY) {
            updateSnapGuides(buildSnapGuideLine(
                matchX ? matchX.guide.value : null,
                matchY ? matchY.guide.value : null,
                boundedMetrics,
                matchX, matchY,
            ));
            return;
        }
        clearSnapGuides();
    };

    // F9 多选边界（依赖 buildGroupMetricsFromIds）
    const getBoundedMultiDragPositions = (positionMap, ids) => {
        if (!positionMap || !Array.isArray(ids) || ids.length === 0) return positionMap;
        const groupMetrics = buildGroupMetricsFromIds(ids, positionMap);
        if (!groupMetrics) return positionMap;
        const boundedGroup = getBoundedDragPosition(groupMetrics, groupMetrics.x, groupMetrics.y);
        const offsetX = boundedGroup.x - groupMetrics.x;
        const offsetY = boundedGroup.y - groupMetrics.y;
        if (offsetX === 0 && offsetY === 0) return positionMap;
        return Object.keys(positionMap).reduce((acc, id) => {
            acc[id] = { x: positionMap[id].x + offsetX, y: positionMap[id].y + offsetY };
            return acc;
        }, {});
    };

    const applyMultiDragPositions = (positionMap) => {
        if (!positionMap) return;
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        if (!stage) return;
        let touchedLayer = null;
        Object.keys(positionMap).forEach((id) => {
            const shape = imagesRef.current.find((s) => s.id === id);
            const node = stage.findOne('#' + id);
            if (!node) return;
            if (shape && shape.draggable === false) {
                node.position({ x: shape.x, y: shape.y });
            } else {
                node.position(positionMap[id]);
            }
            if (!touchedLayer) touchedLayer = node.getLayer();
        });
        if (touchedLayer) touchedLayer.batchDraw();
    };

    // 把所有 Konva 节点的真实位置回写到 imagesRef.current（不触发 setState）。
    // 用于复制 / 剪切 / 对齐 / 等距等批量操作前，确保 imagesRef 与 Konva 视觉位置一致，
    // 避免拖动后偏差累积、刷新 / 复制后元素错位。
    // 不写 history、不调 setImages，调用方按需后续 setImages + history.push。
    const syncKonvaPositionsToImagesRef = () => {
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        if (!stage) return false;
        let mutated = false;
        const next = imagesRef.current.map((shape) => {
            if (!shape || !shape.id) return shape;
            // 锁定元素：不同步（视觉与逻辑就不该飘）
            if (shape.draggable === false) return shape;
            const node = stage.findOne('#' + shape.id);
            if (!node) return shape;
            const nx = node.x();
            const ny = node.y();
            const cx = Number(shape.x) || 0;
            const cy = Number(shape.y) || 0;
            // 浮点容差：< 0.5px 视为相等，避免 Konva 内部浮点累积造成无意义抖动
            if (Math.abs(nx - cx) < 0.5 && Math.abs(ny - cy) < 0.5) return shape;
            mutated = true;
            return { ...shape, x: nx, y: ny };
        });
        if (mutated) {
            imagesRef.current = next;
        }
        return mutated;
    };

    const commitMultiDragPositions = (positionMap) => {
        if (!positionMap) return;
        const nextImages = imagesRef.current.map((shape) => {
            if (!positionMap[shape.id]) return shape;
            if (shape.draggable === false) return shape;
            return { ...shape, x: positionMap[shape.id].x, y: positionMap[shape.id].y };
        });
        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        // 拖动结束保留整组选中（your-feature 风格）：避免 setState 异步过程中
        // 出现 selectedIds=[] 但 selectedId=被拖元素 的中间帧，否则那个成员会闪现蓝色单选框，
        // 且 selectedIdsRef 与 state 不同步会让下一次拖动 startPositions 错算导致另一成员乱跑。
        selectShapes([...selectedIdsRef.current]);
    };

    // 键盘方向键移动选中元素 / 组合 / 多元素 / 多组合
    // - 单选：扩展到整组（与拖动一致）
    // - 多选：直接按 selectedIds 移动（已含整组）
    // - 锁定元素：跳过
    // - 复用 sync + applyMultiDragPositions + commitMultiDragPositions，与拖动同一套提交链路
    // - 每次按键 = 1 次 history.push，撤销精度按 1 步
    const moveSelectionByArrow = (dx, dy) => {
        if (isPreview) return;
        if (!dx && !dy) return;
        // 收集要移动的 id
        let targetIds = [];
        if (Array.isArray(selectedIdsRef.current) && selectedIdsRef.current.length > 0) {
            targetIds = selectedIdsRef.current;
        } else if (selectedIdRef.current) {
            targetIds = getExpandedSelectionIds(selectedIdRef.current);
        }
        if (targetIds.length === 0) return;
        // 过滤锁定元素
        const unlockedIds = targetIds.filter((id) => isShapeUnlocked(id));
        if (unlockedIds.length === 0) return;
        // 先把 Konva 真实位置同步回 imagesRef，避免基于过期 x/y 计算（与对齐/复制同一套保护）
        syncKonvaPositionsToImagesRef();
        // 构造 positionMap：基于当前 imagesRef.x/y + dx/dy
        const positionMap = {};
        unlockedIds.forEach((id) => {
            const shape = imagesRef.current.find((s) => s.id === id);
            if (!shape) return;
            positionMap[id] = {
                x: (Number(shape.x) || 0) + dx,
                y: (Number(shape.y) || 0) + dy,
            };
        });
        // 同步推到 Konva 节点（即时视觉反馈），再提交到 state + history
        applyMultiDragPositions(positionMap);
        commitMultiDragPositions(positionMap);
    };

    // 拖动期间，每次 React 重渲染（例如 onSelect 触发的选中 setState）后立即把 Konva 节点位置重新对齐到 pendingPositions，
    // 避免 <Group {...shapeProps}> 用 imagesRef 旧 x/y 回拉同组成员，造成漂移
    // 用 useLayoutEffect 在浏览器绘制之前同步执行，避免用户看到错位的一帧
    // 关键：只在 pendingPositions 已就绪（dragmove 至少跑过一次）时才 backstop；
    // 否则 dragstart 后、首次 dragmove 前的重渲染会用 startPositions(=origin) 把被拖元素拽回原点，跟 Konva 内部 dragMove 形成对抗，
    // 导致"先 click 再 drag → 拖不动"
    useLayoutEffect(() => {
        if (!multiDragRef.current.active) return;
        const positions = multiDragRef.current.pendingPositions;
        if (positions) applyMultiDragPositions(positions);
    });

    // 多选/组合拖动：dragstart 立即用 Konva 节点真实位置记录所有成员起点。
    // 关键修复：startPositions 必须与 e.target.position() 同源（都来自 Konva 节点）。
    // 旧实现用 imagesRef.current.x/y 做起点，一旦 React 状态与 Konva 节点不同步（如上次拖动 commit、
    // useLayoutEffect backstop、自动保存 setState 等），首帧 delta 会把这部分历史偏差一次性吸收，
    // 然后原封不动加到其他成员上，造成"鼠标选中元素稳，其他元素瞬间偏一下"的乱跑现象。
    const handleShapeDragStart = (e, shape) => {
        const stage = stageRef.current ? stageRef.current.getStage() : null;
        if (!stage) return;
        const expandedSelectedIds = expandDragSelectionIds(selectedIdsRef.current, shape.id);
        const dragSelectedIds = expandedSelectedIds.filter((id) => {
            const currentShape = imagesRef.current.find((item) => item.id === id);
            return currentShape && currentShape.draggable !== false;
        });
        // 单拖：复位 multiDragRef，让 dragmove 走单元素分支（applySnapForShape）
        if (!Array.isArray(dragSelectedIds) || dragSelectedIds.length <= 1 || !dragSelectedIds.includes(shape.id)) {
            multiDragRef.current = {
                active: false,
                draggedId: null,
                startPositions: {},
                pendingPositions: null,
            };
            pendingDragFollowerIdsRef.current = new Set();
            return;
        }
        const startPositions = {};
        dragSelectedIds.forEach((id) => {
            const node = stage.findOne('#' + id);
            if (node) {
                // 用 Konva 节点的真实位置作为起点，与被拖元素 e.target.position() 同源
                startPositions[id] = { x: node.x(), y: node.y() };
            } else {
                const currentShape = imagesRef.current.find((item) => item.id === id);
                if (currentShape) {
                    startPositions[id] = { x: Number(currentShape.x) || 0, y: Number(currentShape.y) || 0 };
                }
            }
        });
        multiDragRef.current = {
            active: true,
            draggedId: shape.id,
            startPositions,
            pendingPositions: null,
        };
        // 记录"跟随成员"：dragend 时这些 id 的 onChange 直接 return，避免每个成员都 push 一次 history
        const followers = new Set();
        dragSelectedIds.forEach((id) => {
            if (id !== shape.id) followers.add(id);
        });
        pendingDragFollowerIdsRef.current = followers;
    };

    // 多选/组合拖动：dragmove 计算 delta 并把所有成员定位到 startPositions[id] + delta
    // dragstart 已经预记录起点；这里保留懒初始化作为兜底（万一 dragstart 未触发也能 fallback）
    const handleShapeDragMove = (e, shape) => {
        const expandedSelectedIds = expandDragSelectionIds(selectedIdsRef.current, shape.id);
        const dragSelectedIds = expandedSelectedIds.filter((id) => {
            const currentShape = imagesRef.current.find((item) => item.id === id);
            return currentShape && currentShape.draggable !== false;
        });
        const isMultiDrag = Array.isArray(dragSelectedIds) && dragSelectedIds.length > 1 && dragSelectedIds.includes(shape.id);
        if (!isMultiDrag) {
            multiDragRef.current = {
                active: false,
                draggedId: null,
                startPositions: {},
                pendingPositions: null,
            };
            applySnapForShape(e.target, shape);
            return;
        }
        if (!snapEnabled) {
            clearSnapGuides();
        }
        // 懒初始化兜底：dragstart 未触发时（极少数情况），用 Konva 节点真实位置记录起点，
        // 与 e.target.position() 同源，避免吸收 React/Konva 不同步的偏差导致其他成员乱跑
        if (!multiDragRef.current.active || multiDragRef.current.draggedId !== shape.id) {
            const stage = stageRef.current ? stageRef.current.getStage() : null;
            const startPositions = {};
            dragSelectedIds.forEach((id) => {
                const node = stage ? stage.findOne('#' + id) : null;
                if (node) {
                    startPositions[id] = { x: node.x(), y: node.y() };
                } else {
                    const currentShape = imagesRef.current.find((item) => item.id === id);
                    if (currentShape) {
                        startPositions[id] = { x: Number(currentShape.x) || 0, y: Number(currentShape.y) || 0 };
                    }
                }
            });
            multiDragRef.current = {
                active: true,
                draggedId: shape.id,
                startPositions,
                pendingPositions: null,
            };
        }
        const startPosition = multiDragRef.current.startPositions[shape.id];
        if (!startPosition) {
            applySnapForShape(e.target, shape);
            return;
        }
        const deltaX = e.target.x() - startPosition.x;
        const deltaY = e.target.y() - startPosition.y;
        let nextPositions = {};
        dragSelectedIds.forEach((id) => {
            const basePos = multiDragRef.current.startPositions[id];
            if (basePos) {
                nextPositions[id] = {
                    x: basePos.x + deltaX,
                    y: basePos.y + deltaY,
                };
            }
        });
        if (snapEnabled) {
            const groupMetrics = buildGroupMetricsFromIds(dragSelectedIds, nextPositions);
            if (groupMetrics) {
                const { matchX, matchY, snappedMetrics } = getSnappedMetrics(groupMetrics, dragSelectedIds);
                if (matchX || matchY) {
                    const offsetX = snappedMetrics.x - groupMetrics.x;
                    const offsetY = snappedMetrics.y - groupMetrics.y;
                    nextPositions = Object.keys(nextPositions).reduce((acc, id) => {
                        acc[id] = {
                            x: nextPositions[id].x + offsetX,
                            y: nextPositions[id].y + offsetY,
                        };
                        return acc;
                    }, {});
                    // 引导线用 ref imperative 绘制，不触发 React 重渲染，多选/组合拖动也能显示
                    updateSnapGuides(buildSnapGuideLine(
                        matchX ? matchX.guide.value : null,
                        matchY ? matchY.guide.value : null,
                        snappedMetrics,
                        matchX, matchY,
                    ));
                } else {
                    clearSnapGuides();
                }
            } else {
                clearSnapGuides();
            }
        } else {
            clearSnapGuides();
        }
        nextPositions = getBoundedMultiDragPositions(nextPositions, dragSelectedIds);
        applyMultiDragPositions(nextPositions);
        multiDragRef.current.pendingPositions = nextPositions;
    };

    // Comment translated to English.
    const handleResize = (stageWidth, stageHeight) => {
        const normalizedWidth = normalizeStageSize(stageWidth, 1920);
        const normalizedHeight = normalizeStageSize(stageHeight, 1080);
        // let sceneWidth = containerRef.current.clientWidth;
        // let scale = sceneWidth / stageWidth;
        let sceneWidth = window.innerWidth;//1730
        // alert(sceneWidth);
        // let sceneHeight = window.innerHeight;//829
        // let scaley = sceneHeight / stageHeight;
        let scalex = sceneWidth / normalizedWidth;
        console.log(new Date() + t('auto.k0334'))
        // console.log(stageWidth)
        // console.log(stageHeight)
        // console.log(scalex)
        // console.log(stageWidth * scalex)
        // console.log(stageHeight * scalex)
        setStageDimensions({
            width: normalizedWidth * scalex,
            height: normalizedHeight * scalex,
            scalex: scalex,
            scaley: scalex,
        });
    };
    // Comment translated to English.
    const handlepredata = (previewjson) => {
        let tplimages = [];// Comment translated to English.
        let tplstaticimages = [];// Comment translated to English.
        if (previewjson) {
            setstageWidth(previewjson.attrs.width);
            stageWidthRef.current = previewjson.attrs.width;
            setstageHeight(previewjson.attrs.height);
            stageHeightRef.current = previewjson.attrs.height;
            setStageDimensions({
                width: stageWidth,
                height: stageHeight,
                scalex: 1,
                scaley: 1,
            });
            handleResize(previewjson.attrs.width, previewjson.attrs.height);
            previewjson.children[0].children.forEach((element) => {
                if (element.attrs.id !== 'canvasBackground' && element.attrs.moduleJson) {
                    if ((element.attrs.moduleJson.attrs.dataKey && element.attrs.moduleJson.attrs.dataKey.length !== 0) || (element.attrs.moduleJson.children && element.attrs.moduleJson.children[0].attrs.cat === 'alarmpie') ||
                        (element.attrs.moduleJson.children && element.attrs.moduleJson.children[0].className === 'alarmList') ||
                        element.attrs.moduleJson.children[0].attrs.name === 'ipImage') {
                        tplimages.push(element.attrs);
                    } else {
                        tplstaticimages.push(element.attrs);
                    }
                }
                if (element.attrs.id === 'canvasBackground') {
                    if (element.attrs.fill) {
                        setBackgroundImage(element.attrs.fill);
                    }
                    if (element.attrs.fillPatternImage) {
                        if (element.attrs.fillPatternImage.indexOf('/public/') > 0) {
                            setBackgroundImage(element.attrs.fillPatternImage.split('/public/')[1]);
                        } else {
                            setBackgroundImage(element.attrs.fillPatternImage);
                        }
                    }
                    if (element.attrs.alarmCatch) {
                        setalarmCatch(element.attrs.alarmCatch)
                        alarmCatchRef.current = element.attrs.alarmCatch;
                    }
                }
            });
        }
        setImagesstatic(tplstaticimages);
        // return PreviewDeal.PreviewDeal(tplimages, procotol, allDevcom, historyData, paramData, snmplist);
        // return PreviewDeal.PreviewDeal(tplimages, procotol, allDevcom, historyData, paramData, allsnmplist, historyparamData, alarmData)
    }
    // Comment translated to English.
    useEffect(() => {
        let isDisposed = false;
        const intervalTimers = [];
        const timeoutTimers = [];
        const registerInterval = (callback, delay) => {
            const id = setInterval(() => {
                if (!isDisposed) {
                    callback();
                }
            }, delay);
            intervalTimers.push(id);
            return id;
        };
        const registerTimeout = (callback, delay) => {
            const id = setTimeout(() => {
                if (!isDisposed) {
                    callback();
                }
            }, delay);
            timeoutTimers.push(id);
            return id;
        };
        const clearAllTimers = () => {
            intervalTimers.forEach((id) => clearInterval(id));
            timeoutTimers.forEach((id) => clearTimeout(id));
            intervalTimers.length = 0;
            timeoutTimers.length = 0;
        };

        // Comment translated to English.
        const onKeyDown = (e) => {
            // 输入框 / 文本域 / contenteditable 焦点时，不拦截任何按键（让用户正常输入）
            const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
            const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select'
                || (e.target && e.target.isContentEditable);
            if (isEditing) return;
            if (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) {
                e.preventDefault();
                ungroupSelectedShapes();
            } else if (e.ctrlKey && (e.key === 'G' || e.key === 'g')) {
                e.preventDefault();
                groupSelectedShapes();
            } else if (e.ctrlKey && (e.key === 'C' || e.key === 'c')) {
                copySelectionToClipboard();
            } else if (e.ctrlKey && (e.key === 'X' || e.key === 'x')) {
                cutSelectionToClipboard();
            } else if (e.ctrlKey && (e.key === 'V' || e.key === 'v')) {
                pasteClipboardSelection();
            } else if (e.ctrlKey && e.key === 'ArrowUp') {
                handleToolChange('up');
            } else if (e.ctrlKey && (e.key === 'Z' || e.key === 'z')) {
                handleToolChange('undo');
            } else if (e.ctrlKey && e.key === 'ArrowDown') {
                handleToolChange('down');
            } else if (!e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                // 方向键移动选中元素 / 组合 / 多元素 / 多组合
                // Shift = 10px 加速，否则 1px 精细微调（Figma / Photoshop 标准）
                // Ctrl + 方向键不在这里处理（Ctrl+↑/↓ 已被层级调整占用）
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                let dx = 0, dy = 0;
                if (e.key === 'ArrowUp') dy = -step;
                else if (e.key === 'ArrowDown') dy = step;
                else if (e.key === 'ArrowLeft') dx = -step;
                else if (e.key === 'ArrowRight') dx = step;
                moveSelectionByArrow(dx, dy);
            } else if (e.ctrlKey && (e.key === 'E' || e.key === 'e')) {
                handleToolChange('top');
            } else if (e.ctrlKey && (e.key === 'B' || e.key === 'b')) {
                handleToolChange('bottom');
                // } else if (e.key === 'A') {
                //     handleToolChange('alginleft');
                // } else if (e.key === 'D') {
                //     handleToolChange('alginright');
                // } else if (e.key === 'W') {
                //     handleToolChange('algintop');
                // } else if (e.key === 'S') {
                //     handleToolChange('alginbottom');
                // } else if (e.key === 'Q') {
                //     handleToolChange('algincenter');
                // } else if (e.key === 'E') {
                //     handleToolChange('alginvertical');
            } else if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
                e.preventDefault();
                unlockSelectedShapes();
            } else if (e.ctrlKey && (e.key === 'K' || e.key === 'k')) {
                e.preventDefault();
                lockSelectedShapes();
            } else if (e.ctrlKey && (e.key === 'L' || e.key === 'l')) {
                handleToolChange('lock');
            } else if (e.ctrlKey && (e.key === 'N' || e.key === 'n')) {
                handleToolChange('unlock');
            } else if (e.ctrlKey && (e.key === 'S' || e.key === 's')) {
                if (savePageId !== '0' && savePageType === '1') {
                    savePage('page')
                }
            } else if (e.key === 'Delete') {
                handleToolChange('del');
                // } else if (e.key === 'F' || e.key === 'f') {
                //     if (!document.fullscreenElement) {
                // Comment translated to English.
                //         document.documentElement.requestFullscreen().then(() => {
                //             handleResize(stageWidthRef.current, stageHeightRef.current);
                //         });
                //     }
            } else {
                return;
            }
        }
        window.addEventListener('keydown', onKeyDown);
        // Comment translated to English.
        // const checkFull = () => {
        //     if (!document.webkitIsFullScreen && !document.mozFullScreen && !document.msFullscreenElement) {
        // Comment translated to English.
        //         handleResize(stageWidthRef.current, stageHeightRef.current);
        //     } else {
        // Comment translated to English.
        //     }
        // };
        // window.addEventListener("webkitfullscreenchange", checkFull);
        // window.addEventListener("mozfullscreenchange", checkFull);
        // window.addEventListener("fullscreenchange", checkFull);
        // window.addEventListener("MSFullscreenChange", checkFull);

        // Comment translated to English.
        async function gettxtdata() {
            let conres = await httpsend.getDataLocal('imgData', { action: 'page', name: txttitle })
            const hasPageData = conres
                && conres.code === 100
                && conres.data
                && conres.data[0]
                && typeof conres.data[0].moduleJson === 'string'
                && conres.data[0].moduleJson.indexOf('{') > -1;
            if (!hasPageData) return '';

            try {
                return JSON.parse(JSON.parse(conres.data[0].moduleJson))
            } catch (e) {
                return '';
            }
        }

        let pageTime;// Comment translated to English.
        let pageTimecalc = 0;// Comment translated to English.
        let pageHistoryTime;// Comment translated to English.
        let pageparamHistoryTime;// Comment translated to English.

        // Comment translated to English.
        if (isPreview) {
            // handleResize();
            // Comment translated to English.
            // Comment translated to English.
            const getDateTime = (timeStr) => {
                var time = timeStr ? timeStr : new Date();
                var y = time.getFullYear();
                var m = time.getMonth() + 1;
                m = m < 10 ? ("0" + m) : m;
                var d = time.getDate();
                d = d < 10 ? ("0" + d) : d;
                return y + "-" + m + "-" + d;
            }

            let procotol;// Comment translated to English.
            let allDevcom;// Comment translated to English.
            let paramData;// Comment translated to English.
            let historyData;// Comment translated to English.
            let alarmData = {
                data: []
            };// Comment translated to English.
            // Comment translated to English.
            let historyparamData;// Comment translated to English.
            let allsnmplist;// Comment translated to English.

            // var reportStart = getDateTime(new Date(new Date() - 1000 * 60 * 60 * 24 * 8)) + ' 00:00:00';
            // var reportEnd = getDateTime(new Date(new Date())) + ' 23:59:59';
            let allDev = [];// Comment translated to English.
            let DevID = [];// Comment translated to English.
            let DevIDParam = [];// Comment translated to English.
            let DevSpareID = {};// Comment translated to English.
            let DevParID = [];// Comment translated to English.
            let DevSnmp = [];// Comment translated to English.
            let DevPar = [];// Comment translated to English.

            let pageparamHistoryDate = '';// Comment translated to English.
            if (localStorage.getItem('pageparamHistoryDate')) {
                pageparamHistoryDate = localStorage.getItem('pageparamHistoryDate')
            } else {
                pageparamHistoryDate = getDateTime(new Date(new Date()));
                localStorage.setItem('pageparamHistoryDate', pageparamHistoryDate);
            }
            // let pageparamHistoryDate ='2024-12-10';
            // Comment translated to English.
            const getHisDevId = async (imagesdata) => {
                imagesdata.forEach((shapeProps) => {
                    // Comment translated to English.
                    if (shapeProps.attrs.moduleJson && shapeProps.attrs.moduleJson.children[0].className === 'Echart' && shapeProps.attrs.moduleJson.children[0].attrs.cat === 'line') {
                        const dataKey = shapeProps.attrs.moduleJson.attrs.dataKey;// Comment translated to English.
                        if (dataKey && dataKey.length > 0) {
                            // Comment translated to English.
                            dataKey.forEach((el) => {
                                // console.log(el)
                                if (el.devkey) {// Comment translated to English.
                                    if (el.src && el.src.indexOf('@') > -1) {
                                        // Comment translated to English.
                                        let serverIP = el.src.split('@')[0];
                                        let devkey = el.src.split('@')[1];
                                        if (!DevSpareID[serverIP]) {
                                            DevSpareID[serverIP] = {
                                                devkey: [],
                                                cmdtype: [],
                                                devTodev: [],
                                                serverIP: serverIP
                                            };
                                        }
                                        DevSpareID[serverIP].devkey.push(devkey);
                                        DevSpareID[serverIP].cmdtype.push(el.cmdtype);
                                        DevSpareID[serverIP].devTodev.push(devkey + '-' + el.devkey);// Comment translated to English.
                                    } else {
                                        DevID.push(el.devkey)
                                        DevIDParam.push(el.cmdtype)
                                    }
                                }
                            })
                        }
                    }

                    // Comment translated to English.
                    if (shapeProps.attrs.moduleJson &&
                        shapeProps.attrs.moduleJson.attrs.dataKey &&
                        shapeProps.attrs.moduleJson.attrs.dataKey.length !== 0 &&
                        (shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('parkey') || shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('paramskey'))) {
                        const dataKey = shapeProps.attrs.moduleJson.attrs.dataKey;// Comment translated to English.
                        if (dataKey && dataKey.length > 0) {
                            dataKey.forEach((el) => {
                                if (el.parkey) DevPar.push(el.parkey)
                            })
                        }
                    }
                    if (shapeProps.attrs.moduleJson &&
                        shapeProps.attrs.moduleJson.attrs.dataKey &&
                        shapeProps.attrs.moduleJson.attrs.dataKey.length !== 0 &&
                        shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('paramskey')) {
                        const dataKey = shapeProps.attrs.moduleJson.attrs.dataKey;// Comment translated to English.
                        if (dataKey && dataKey.length > 0) {
                            dataKey.forEach((el) => {
                                if (el.paramskey) DevParID.push(el.paramskey)
                            })
                        }
                    }

                    // Comment translated to English.

                    // Comment translated to English.
                    // Comment translated to English.
                    // Comment translated to English.
                    // Comment translated to English.
                    // Comment translated to English.
                    if (shapeProps.attrs.moduleJson &&
                        shapeProps.attrs.moduleJson.attrs.dataKey &&
                        shapeProps.attrs.moduleJson.attrs.dataKey.length !== 0) {
                        // && shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('type') ) {
                        //&& shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('name')
                        const dataKey = shapeProps.attrs.moduleJson.attrs.dataKey;// Comment translated to English.
                        if (dataKey && dataKey.length > 0) {
                            dataKey.forEach((el) => {
                                if (el.type === '3' && shapeProps.attrs.moduleJson.attrs.dataKey[0].hasOwnProperty('name')) {
                                    DevSnmp.push(el.key ? el.key : el.devkey);
                                }
                                allDev.push(el.key ? el.key : el.devkey);
                            })
                        }
                    }

                })

                DevSnmp = [...new Set(DevSnmp)];// Comment translated to English.
                // console.log('DevSnmp');
                // console.log(DevSnmp);
                if (DevSnmp.length !== 0) {
                    getSnmpParamData(DevSnmp.join(','));
                } else {
                    allsnmplist = {
                        data: []
                    }
                }

                DevParID = [...new Set(DevParID)];// Comment translated to English.
                // console.log('DevParID');
                // console.log(DevParID);
                if (DevParID.length !== 0) {
                    getHistoryParamData(DevParID.join(','));
                } else {
                    historyparamData = {
                        data: []
                    }
                }

                DevID = [...new Set(DevID)];// Comment translated to English.
                // Comment translated to English.
                // console.log('DevID');
                // console.log(DevID);
                // console.log('DevSpareID')
                // console.log(DevSpareID)
                if (DevID.length !== 0 || Object.keys(DevSpareID).length > 0) {
                    DevIDParam = [...new Set(DevIDParam)];// Comment translated to English.
                    getHistoryData(DevID.join(','), DevIDParam.join(','), DevSpareID);
                } else {
                    historyData = {
                        data: []
                    }
                }

                DevPar = [...new Set(DevPar)];// Comment translated to English.
                // console.log('DevPar');
                // console.log(DevPar);
                if (DevPar.length !== 0) getParamData();

                allDev = [...new Set(allDev)];// Comment translated to English.
                // console.log('allDev');
                // console.log(allDev);
                if (allDev.length !== 0) {
                    getAllcom(allDev.join(','));
                } else {
                    allDevcom = {
                        data: []
                    }
                }
            }
            // Comment translated to English.
            const getpro = async () => {
                let res = await httpsend.getData('GetDeviceProtocolListKey', {
                    ComboBox: 'all'
                })
                if (res) procotol = res
            }
            // Comment translated to English.
            const getAllcom = async (id) => {
                let res = await httpsend.getData('GetDevCommandListKey', {
                    ComboBox: 'all',
                    DevIDs: id
                })
                if (res) allDevcom = res
            }
            // Comment translated to English.
            const getParamData = async () => {
                let res = await httpsend.getData('GetParamListKey', {
                    ComboBox: 'calc'
                })
                if (res) paramData = res
            }
            // Comment translated to English.
            const getSnmpParamData = async (id) => {
                let res = await httpsend.getData('GetSnmpParamListKey', {
                    DevIDs: id,
                    DataType: t('auto.k0335'),
                    ComboBox: 'all'
                })
                if (res) allsnmplist = res
            }
            // Comment translated to English.
            const getHistoryData = async (DevID, DevIDParam, DevSpareID = {}) => {
                let waitHistoryData = {};
                if (DevID) {
                    let res = await httpsend.getData('GetHistoryAlarmsKey', {
                        startDateTime: getDateTime(new Date(new Date() - 1000 * 60 * 60 * 24 * 8)) + ' 00:00:00',
                        endDateTime: getDateTime(new Date(new Date())) + ' 23:59:59',
                        DevID: DevID,
                        keyword: DevIDParam,
                        ComboBox: 'all'
                    })
                    if (res) waitHistoryData = res;
                }
                // Comment translated to English.
                // console.log(DevSpareID)
                // console.log(DevSpareID.length)
                if (DevSpareID) {
                    // Comment translated to English.
                    for (var kes in DevSpareID) {
                        // DevSpareID[serverIP] = {
                        //     devkey: [],
                        //     cmdtype: [],
                        //     devTodev: [],
                        //     serverIP: serverIP
                        // };
                        // Comment translated to English.

                        let spareUrl = buildMainApiUrl('GetHistoryAlarmsKey', kes);
                        let spareDevId = [...new Set(DevSpareID[kes].devkey)];
                        let spareDevCmd = [...new Set(DevSpareID[kes].cmdtype)];
                        let spareMap = [...new Set(DevSpareID[kes].devTodev)];// Comment translated to English.
                        let spareObj = {};
                        spareMap.forEach(item => {
                            const [key, value] = item.split('-');
                            spareObj[key] = parseInt(value);
                        });
                        console.log(t('auto.k0336'))
                        console.log(spareUrl)
                        // console.log(spareDevId)
                        // console.log(spareDevCmd)
                        console.log(spareObj)

                        let spareRes = await httpsend.handlePostSubmit(spareUrl, {
                            startDateTime: getDateTime(new Date(new Date() - 1000 * 60 * 60 * 24 * 8)) + ' 00:00:00',
                            endDateTime: getDateTime(new Date(new Date())) + ' 23:59:59',
                            DevID: spareDevId,
                            keyword: spareDevCmd,
                            ComboBox: 'all'
                        })
                        if (spareRes) {
                            spareRes.data.forEach((ele) => {
                                ele.DevID = spareObj[ele.DevID].toString() || ele.DevID.toString()
                            })
                            if (!waitHistoryData.data) {
                                waitHistoryData.data = [];
                            }
                            waitHistoryData.data = waitHistoryData.data.concat(spareRes.data);
                            // console.log(waitHistoryData)
                        }
                    }
                }
                if (waitHistoryData) historyData = waitHistoryData;
            }
            // Comment translated to English.
            const getHistoryParamData = async (parID) => {
                let res = await httpsend.getData('GetParamDayListKey', {
                    startDateTime: getDateTime(new Date(new Date() - 1000 * 60 * 60 * 24 * 8)) + ' 00:00:00',
                    endDateTime: getDateTime(new Date(new Date())) + ' 23:59:59',
                    ParamIds: parID,
                    ComboBox: 'all'
                })
                if (res) historyparamData = res
            }

            // Comment translated to English.
            const getAlarmData = async () => {
                let res = await httpsend.getData('GetAlarmListKey', {
                    type: '1',
                    ComboBox: 'all'
                })
                if (res) alarmData = res;
            }

            // Comment translated to English.
            const getSystemStartTime = async () => {
                let res = await httpsend.getData('GetLogoKey', {
                })
                if (res && res.data && res.data[0].create_time) localStorage.setItem('SystemStartTime', res.data[0].create_time)
            }

            // Comment translated to English.
            // const getEventData = async () => {
            //     let res = await httpsend.getData('GetEventListKey', {
            //         type: '1',
            //         ComboBox: 'all'
            //     })
            //     if (res) eventData = res;
            // }

            getpro();
            getSystemStartTime();

            // Comment translated to English.
            const setNewView = () => {
                // Comment translated to English.
                let startviewTime = new Date().getTime();
                let tplimages = [];
                const previewjson = previewDataRef.current;
                if (previewjson) {
                    previewjson.children[0].children.forEach((element) => {
                        if (element.attrs.id !== 'canvasBackground' && element.attrs.moduleJson) {
                            if ((element.attrs.moduleJson.attrs.dataKey && element.attrs.moduleJson.attrs.dataKey.length !== 0) ||
                                (element.attrs.moduleJson.children && element.attrs.moduleJson.children[0].attrs.cat === 'alarmpie') ||
                                (element.attrs.moduleJson.children && element.attrs.moduleJson.children[0].className === 'alarmList') ||
                                element.attrs.moduleJson.children[0].attrs.name === 'ipImage'
                            ) {
                                tplimages.push(element.attrs);
                            }
                        }
                    });
                }
                let newtplimages = PreviewDeal.PreviewDeal(tplimages, procotol, allDevcom, historyData, paramData, allsnmplist, historyparamData, alarmData);
                registerTimeout(() => {
                    // Comment translated to English.
                    let endviewTime = new Date().getTime();
                    console.log(t('auto.k0337') + (parseInt(endviewTime) - parseInt(startviewTime)))
                    // console.log(JSON.parse(JSON.stringify(newtplimages)));
                    console.log(txttitle + t('auto.k0338'));
                    setImagesdata(JSON.parse(JSON.stringify(newtplimages)));
                    imagesRef.current = JSON.parse(JSON.stringify(newtplimages));
                    setChart(JSON.parse(JSON.stringify(newtplimages)), null, alarmData);
                }, 500)
            }

            // let newtplimages;
            // Comment translated to English.
            const getPageInfo = async () => {
                if (txttitle) {
                    previewDataRef.current = await gettxtdata();
                } else {
                    previewDataRef.current = JSON.parse(JSON.parse(localStorage.getItem('stageJson')));
                }
                if (isDisposed) return;
                const previewjson = previewDataRef.current;
                if (previewjson) {
                    await getHisDevId(previewjson.children[0].children);
                    if (isDisposed) return;
                    handlepredata(previewjson);// Comment translated to English.
                    setNewView()// Comment translated to English.
                } else {
                    message.error(txttitle + t('auto.k0339'));
                }
            };
            getPageInfo();

            var devtime = registerInterval(async () => {
                // console.log(allDevcom)
                // console.log(devtime)
                if (allDevcom && allDevcom.data && devtime) {
                    clearInterval(devtime);
                    console.log(t('auto.k0340') + new Date())
                    console.log(t('auto.k0341') + new Date())
                    // Comment translated to English.
                    // Comment translated to English.
                    // Comment translated to English.
                    setNewView();
                    // setTimeout(() => {
                    console.log(t('auto.k0342'));
                    console.log('DevID');
                    console.log(DevID);
                    console.log('DevSpareID')
                    console.log(DevSpareID)
                    if (DevID.length !== 0 || Object.keys(DevSpareID).length > 0) {
                        console.log(t('auto.k0343') + new Date())
                        var historytime = registerInterval(() => {
                            if (historyData && historyData.msg) {// Comment translated to English.
                                clearInterval(historytime);
                                // havehis = true;
                                setPageView();
                                console.log(t('auto.k0344') + new Date())
                                // Comment translated to English.
                                pageHistoryTime = registerInterval(() => {
                                    console.log(txttitle + t('auto.k0345'));
                                    getHistoryData(DevID.join(','), DevIDParam.join(','), DevSpareID);
                                }, 600000)
                            }
                        }, 10)
                    } else {
                        // havehis = true;
                        setPageView()
                        console.log(t('auto.k0346'))
                    }
                    if (DevParID.length !== 0) {
                        console.log(t('auto.k0347') + new Date())
                        var historyparamtime = registerInterval(() => {
                            if (historyparamData && historyparamData.msg) {// Comment translated to English.
                                clearInterval(historyparamtime);
                                // havehispar = true;
                                setPageView();
                                console.log(t('auto.k0348') + new Date())
                                // Comment translated to English.
                                // Comment translated to English.
                                pageparamHistoryTime = registerInterval(() => {
                                    let todayDate = getDateTime(new Date(new Date()));
                                    console.log(txttitle + t('auto.k0349') + pageparamHistoryDate);
                                    console.log(txttitle + t('auto.k0350') + todayDate);
                                    if (pageparamHistoryDate !== todayDate) {
                                        getHistoryParamData(DevParID.join(','));
                                        console.log(txttitle + t('auto.k0351'));
                                        pageparamHistoryDate = todayDate;// Comment translated to English.
                                        localStorage.setItem('pageparamHistoryDate', todayDate);
                                    }
                                }, 3600000)
                                // },10000)
                            }
                        }, 10)

                    } else {
                        // havehispar = true;
                        setPageView();
                        console.log(t('auto.k0352'))
                    }
                    if (DevSnmp.length !== 0) {
                        console.log(t('auto.k0353') + new Date())
                        var snmptime = registerInterval(() => {
                            if (allsnmplist && allsnmplist.msg) {// Comment translated to English.
                                clearInterval(snmptime);
                                // havesnmp=true;
                                setPageView();
                                console.log(t('auto.k0354') + new Date())
                            }
                        }, 10)
                    } else {
                        // havesnmp=true;
                        setPageView();
                        console.log(t('auto.k0355'))
                    }
                    if (DevPar.length !== 0) {
                        console.log(t('auto.k0356') + new Date())
                        var cuspartime = registerInterval(() => {
                            if (paramData && paramData.msg) {// Comment translated to English.
                                clearInterval(cuspartime);
                                setPageView();
                                console.log(t('auto.k0357') + new Date())
                            }
                        }, 10)
                    } else {
                        setPageView();
                        console.log(t('auto.k0358'))
                    }
                    // }, 100);
                    function setPageView() {
                        // console.log()
                        // if (!newtplimages) return false;
                        // setImagesdata(JSON.parse(JSON.stringify(newtplimages)));
                        // imagesRef.current = JSON.parse(JSON.stringify(newtplimages));
                        // setChart(JSON.parse(JSON.stringify(newtplimages)), null);
                        setNewView();
                    }
                }
                console.log(t('auto.k0359') + new Date())
            }, 10)
            pageTime = registerInterval(() => {
                if (allDev.length !== 0) getAllcom(allDev.join(','));
                if (DevPar.length !== 0) getParamData();
                if (alarmCatchRef.current === '1') getAlarmData();
                setNewView();
                pageTimecalc++;
                console.log(pageTimecalc);
            }, 10000)
            // window.addEventListener("resize", handleResize(stageWidthRef.current, stageHeightRef.current), false);
        }
        // handleResize();
        // window.addEventListener("resize", handleResize, false);
        // return () => window.addEventListener("resize", handleResize, false);
        return () => {
            isDisposed = true;
            window.removeEventListener("keydown", onKeyDown);
            clearAllTimers();
            clearInterval(pageTime);
            if (pageHistoryTime) clearInterval(pageHistoryTime);
            if (pageparamHistoryTime) clearInterval(pageparamHistoryTime);
        }
    }, []);// Comment translated to English.

    // Comment translated to English.
    useEffect(() => {
        const nodes = selectedIds
            .filter((id) => isShapeUnlocked(id))
            .map((id) => layerRef.current.findOne("#" + id))
            .filter(Boolean);
        if (transformRefids.current) {
            transformRefids.current.nodes(nodes);
        }
    }, [selectedIds]);

    // Comment translated to English.
    useEffect(() => {
        if (showsavePageBox === 1) {
            // Comment translated to English.
            setTimeout(async () => {
                let res = await httpsend.getData('GetDmpageListKey', { ComboBox: '1' })
                let options = [{
                    value: '0',
                    label: t('auto.k0360')
                }];
                if (res) {
                    res.data.forEach((el) => {
                        let firstop = {
                            value: el.id,
                            label: el.PageName
                        }
                        if (el.children.length !== 0) {
                            firstop.children = [];
                            el.children.forEach((y) => {
                                let secop = {
                                    value: y.id,
                                    label: y.PageName
                                }
                                if (y.children.length !== 0) {
                                    secop.children = [];
                                    y.children.forEach((m) => {
                                        let throp = {
                                            value: m.id,
                                            label: m.PageName
                                        }
                                        secop.children.push(throp)
                                    })
                                }
                                firstop.children.push(secop)
                            })
                        }
                        options.push(firstop);
                    })
                }
                setsavePagePidSel(options);
            });
        }

    }, [showsavePageBox]);

    // Comment translated to English.
    const checkDeselect = async () => {
        // const clickedOnEmpty = e.target === e.target.getStage();
        // if (clickedOnEmpty) {
        console.log("remove all selections")
        selectShapes([]);
        selectedIdsRef.current = [];
        setSelectedId(null);
        selectedIdRef.current = null;
        setDragShape(null);
        settoolType(null);
        // }
    };
    // Comment translated to English.
    const onClickTap = async (e) => {
        if (e === 'handle') {
            checkDeselect();
            return;
        }
        // Comment translated to English.
        const { x1, x2, y1, y2 } = selection.current;
        const moved = x1 !== x2 || y1 !== y2;
        if (moved) {
            return;
        }
        let stage = e.target.getStage();
        let layer = layerRef.current;
        let tr = transformRefids.current;

        // Comment translated to English.
        if (e.target === stage || e.target.id() === 'canvasBackground') {
            checkDeselect();
            return;
        }
        // 多选键：Ctrl（Win/Linux）或 Cmd（Mac）。Shift 不再触发多选
        const metaPressed = e.evt.ctrlKey || e.evt.metaKey;
        const clickedShapeId = e.target.parent.attrs.id;
        // 把 "已选" 判断扩展到整组：onSelect 已经把同组成员装入 selectedIdsRef，这里要识别成已选
        const isSelected = tr.nodes().indexOf(e.target) >= 0
            || (selectedIdsRef.current && selectedIdsRef.current.includes(clickedShapeId));
        const isDrag = e.target.parent.attrs.draggable;
        if (!isDrag) { message.error(t('auto.k0361')); return; }
        // 点击成员所在整组（组合则展开为整组成员，单元素则就是自身）
        const clickedGroupIds = getUnlockedExpandedSelectionIds(clickedShapeId);
        if (!metaPressed && !isSelected) {
            // 无修饰键 + 未选中：清空选区（具体单选/整组选交给 onSelect 处理）
            selectShapes([]);
            selectedIdsRef.current = [];
            return;
        } else if (metaPressed && isSelected) {
            // Ctrl + 已选：把整组从选区中整体移除
            selectShapes((oldShapes) => {
                const removeSet = new Set(clickedGroupIds);
                const ids = oldShapes.filter((oldId) => !removeSet.has(oldId));
                selectedIdsRef.current = ids;
                return ids;
            });
        } else if (metaPressed && !isSelected) {
            // Ctrl + 未选：把整组成员加入选区，并保留之前的 selectedId（若可拖）
            selectShapes((oldShapes) => {
                let resShapes = oldShapes;
                if (selectedId && oldShapes.indexOf(selectedId) === -1) {
                    const isDragIndex = images.findIndex((findid) => selectedId === findid.id);
                    if (isDragIndex !== -1) {
                        const prevDraggable = images[isDragIndex].draggable;
                        if (prevDraggable) {
                            // 之前的 selectedId 也要按整组扩展
                            const prevGroupIds = getUnlockedExpandedSelectionIds(selectedId);
                            prevGroupIds.forEach((id) => {
                                if (!resShapes.includes(id)) resShapes = [...resShapes, id];
                            });
                        }
                    }
                }
                clickedGroupIds.forEach((id) => {
                    if (!resShapes.includes(id)) resShapes = [...resShapes, id];
                });
                selectedIdsRef.current = resShapes;
                return resShapes;
            });
        }
        layer.draw();
    }
    // Comment translated to English.
    // Comment translated to English.
    const updateSelectionRect = (type) => {
        const node = selectionRectRef.current;
        if (type) {
            node.setAttrs({
                visible: false,
                x: 0,
                y: 0,
                width: 0,
                height: 0
            });
            selection.current.visible = false;
            selection.current.x1 = 0;
            selection.current.x2 = 0;
            selection.current.y1 = 0;
            selection.current.y2 = 0;
        } else {
            node.setAttrs({
                visible: selection.current.visible,
                x: Math.min(selection.current.x1, selection.current.x2),
                y: Math.min(selection.current.y1, selection.current.y2),
                width: Math.abs(selection.current.x1 - selection.current.x2),
                height: Math.abs(selection.current.y1 - selection.current.y2),
                fill: "rgba(0, 161, 255, 0.3)"
            });
        }
        node.getLayer().batchDraw();
    };
    const onMouseDown = (e) => {
        if (e.target !== e.target.getStage() && e.target.id() !== 'canvasBackground') {
            return;
        }
        const pos = e.target.getStage().getPointerPosition();
        selection.current.visible = true;
        selection.current.x1 = pos.x / stageDimensions.scalex;
        selection.current.y1 = pos.y / stageDimensions.scalex;
        selection.current.x2 = pos.x / stageDimensions.scalex;
        selection.current.y2 = pos.y / stageDimensions.scalex;
        setMarqueeHoverIds([]);
        updateSelectionRect();
    };
    const onMouseMove = (e) => {
        if (!selection.current.visible) {
            return;
        }
        const pos = e.target.getStage().getPointerPosition();
        selection.current.x2 = pos.x / stageDimensions.scalex;
        selection.current.y2 = pos.y / stageDimensions.scalex;
        updateSelectionRect();
        // 实时计算与选框相交的可拖动元素 id
        const selBox = selectionRectRef.current.getClientRect();
        const hoverIds = [];
        layerRef.current.find(".group").forEach((elementNode) => {
            const elBox = elementNode.getClientRect();
            if (Konva.Util.haveIntersection(selBox, elBox)) {
                const sid = elementNode.attrs.id;
                const shape = imagesRef.current.find((s) => s.id === sid);
                if (shape && shape.draggable !== false) {
                    hoverIds.push(sid);
                }
            }
        });
        setMarqueeHoverIds((prev) => {
            if (prev.length === hoverIds.length && prev.every((id, i) => id === hoverIds[i])) {
                return prev;
            }
            return hoverIds;
        });
    };
    const onMouseUp = () => {
        oldPos.current = null;
        selection.current.visible = false;
        const { x1, x2, y1, y2 } = selection.current;
        const moved = x1 !== x2 || y1 !== y2;
        if (!moved) {
            setMarqueeHoverIds([]);
            updateSelectionRect();
            return;
        }
        const selBox = selectionRectRef.current.getClientRect();
        const elements = [];
        layerRef.current.find(".group").forEach((elementNode) => {
            const elBox = elementNode.getClientRect();
            if (Konva.Util.haveIntersection(selBox, elBox)) {
                elements.push(elementNode);
            }
        });
        let ids = elements.map((el) => el.attrs.id);
        selectShapes(ids);
        selectedIdsRef.current = ids;
        setMarqueeHoverIds([]);
        updateSelectionRect('remove');
    };
    // Comment translated to English.

    // Comment translated to English.
    // Comment translated to English.
    const handleItemDragUrl = async (dragUrl, dragAttrs, type) => {
        setDragUrl(dragUrl);
        if (type) {
            let conres = await httpsend.getDataLocal('imgData', { action: 'page', name: type.split('&')[0] });
            if (conres) {
                // seteditPageId(type.split('&')[3]);
                // seteditPageName(type.split('&')[2]);
                // seteditPageType(type.split('&')[4]);
                setsavePageTxt(type.split('&')[0]);
                setsavePageId(type.split('&')[3]);
                setsavePageName(type.split('&')[2]);
                setsavePageType(type.split('&')[4].toString());
                const hasPageData = conres.code === 100
                    && conres.data
                    && conres.data[0]
                    && typeof conres.data[0].moduleJson === 'string';
                if (!hasPageData) {
                    setDragAttrs('');
                    dealStringPage('');
                } else {
                    setDragAttrs(conres.data[0].moduleJson);
                    // Comment translated to English.
                    dealStringPage(conres.data[0].moduleJson);
                }
            }
        } else {
            setDragAttrs(dragAttrs);
        }
    };
    // Comment translated to English.
    const dealStringPage = (dragAttrs) => {
        let tplimages = [];
        let dargJson = null;
        setBackgroundImage(null);
        setalarmCatch('1');
        alarmCatchRef.current = '1';
        if (typeof dragAttrs === 'string' && dragAttrs.indexOf('{') > -1) {
            try {
                dargJson = JSON.parse(JSON.parse(dragAttrs));
            } catch (e) {
                try {
                    dargJson = JSON.parse(dragAttrs);
                } catch (e2) {
                    dargJson = null;
                }
            }
        } else if (dragAttrs && typeof dragAttrs === 'object' && dragAttrs.className === 'Stage') {
            dargJson = dragAttrs;
        }

        if (dargJson && dargJson.children && dargJson.children[0] && dargJson.children[0].children) {
            setstageWidth(dargJson.attrs.width);
            setstageHeight(dargJson.attrs.height);
            setStageDimensions({
                width: stageWidth,
                height: stageHeight,
                scalex: 1,
                scaley: 1,
            });
            setcanvasScale(100);
            dargJson.children[0].children.forEach(element => {
                if (element.attrs.id !== 'canvasBackground') {
                    tplimages.push(element.attrs);
                } else {
                    if (element.attrs.fillPatternImage) {
                        if (element.attrs.fillPatternImage.indexOf('/public/') > 0) {
                            setBackgroundImage(element.attrs.fillPatternImage.split('/public/')[1]);
                        } else {
                            setBackgroundImage(element.attrs.fillPatternImage);
                        }
                    } else {
                        setBackgroundImage(element.attrs.fill);
                    }
                    if (element.attrs.alarmCatch) {
                        setalarmCatch(element.attrs.alarmCatch)
                        alarmCatchRef.current = element.attrs.alarmCatch;
                    }
                }
            });
        }
        // F5 切换模板/页面前先清理多拖 / 磁吸 / 选择 / hover 状态
        multiDragRef.current = {
            active: false,
            draggedId: null,
            startPositions: {},
            pendingPositions: null,
        };
        clearSnapGuides();
        selectShapes([]);
        selectedIdsRef.current = [];
        setSelectedId(null);
        selectedIdRef.current = null;
        setDragShape(null);
        settoolType(null);
        setHoverHighlightIds([]);
        setImages(tplimages);
        imagesRef.current = tplimages;
        setChart(JSON.parse(JSON.stringify(imagesRef.current)), null, null);
        history = [];
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        // F11b 精简版：刚加载完页面，把 dirty 状态压回去（避免随之而来的 setImages 把刚加载的内容判脏）
        markPageLoaded();
        // 切换页面 → 换新 token（用于跨页面复制粘贴判定）
        currentPageTokenRef.current = 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    }
    // Comment translated to English.
    const handleOnDrop = (e) => {
        // Comment translated to English.
        if (e) {
            e.preventDefault();
            stageRef.current.setPointersPositions(e);// Comment translated to English.
        }
        if (typeof dragAttrs === 'string' || (dragAttrs && typeof dragAttrs === 'object' && dragAttrs.className === 'Stage')) {
            // Comment translated to English.
            setsavePageType('1');
            dealStringPage(dragAttrs);
            // Comment translated to English.
            setcanvasScale(100);
        } else {
            let eleId = parseInt(new Date().getTime()).toString()// Comment translated to English.
            // Comment translated to English.
            // console.log(stageRef.current.getPointerPosition());
            let newX = stageRef.current.getPointerPosition().x / stageDimensions.scalex;
            let newY = stageRef.current.getPointerPosition().y / stageDimensions.scalex;
            // console.log(newX)
            // console.log(newY)
            let shape = {
                // ...stageRef.current.getPointerPosition(),
                x: newX,
                y: newY,
                src: dragUrl,
                moduleJson: dragAttrs,
                id: eleId,
                draggable: true,
                time: new Date().toLocaleString(),
                width: dragAttrs.width,
                height: dragAttrs.height
            }
            setImages(// Comment translated to English.
                images.concat([shape])
            );
            imagesRef.current = images.concat([shape]);
            history.push(JSON.parse(JSON.stringify(imagesRef.current)));

            setSelectedId(null);
            setDragShape(null);
            setTimeout(() => {
                // Comment translated to English.
                setDragShape(shape);
                setSelectedId(shape.id)// Comment translated to English.
                selectedIdRef.current = shape.id;
                setChart(JSON.parse(JSON.stringify(imagesRef.current)), selectedIdRef.current, null);
            })
        }
    };
    // Comment translated to English.
    // Comment translated to English.
    const handleShapeChange = (newShapeProps, id) => {
        // F6 多选拖动：跟随成员的 onChange 走到这里也直接丢弃（兜底，正常路径已在 JSX onChange 里 return）
        if (pendingDragFollowerIdsRef.current.has(newShapeProps && newShapeProps.id)) {
            pendingDragFollowerIdsRef.current.delete(newShapeProps.id);
            return;
        }
        // F6 多选拖动：如果当前正在多选拖动，由 commitMultiDragPositions 统一提交，单点 onChange 跳过
        if (multiDragRef.current.active && multiDragRef.current.pendingPositions) {
            const pending = multiDragRef.current.pendingPositions;
            multiDragRef.current = {
                active: false,
                draggedId: null,
                startPositions: {},
                pendingPositions: null,
            };
            pendingDragFollowerIdsRef.current = new Set();
            commitMultiDragPositions(pending);
            return;
        }
        let imagesToUpdate = images;
        const findIndex = images.findIndex((img) => img.id === newShapeProps.id);
        let singleImageToUpdate = imagesToUpdate[findIndex];
        singleImageToUpdate = newShapeProps;
        imagesToUpdate[findIndex] = singleImageToUpdate;
        setImages(JSON.parse(JSON.stringify(imagesToUpdate)));
        imagesRef.current = JSON.parse(JSON.stringify(imagesToUpdate));
        history.push(imagesToUpdate);
        setChart(imagesRef.current, selectedIdRef.current, null);
        if (selectedIdsRef.current.length === 0) {
            if (id) {
                setSelectedId(null);
                selectedIdRef.current = null;
                setDragShape(null);
            }
            setTimeout(() => {
                // Comment translated to English.
                setSelectedId(newShapeProps.id);
                selectedIdRef.current = newShapeProps.id;
                setDragShape(newShapeProps);
            })
        } else {
            selectShapes(selectedIdsRef.current)
        }
    };
    // Comment translated to English.
    const handleToolBack = async (newShapeProps, type) => {
        switch (type) {
            case 'copy':
                if (newShapeProps !== null) {
                    let eleId = parseInt(new Date().getTime()).toString()// Comment translated to English.
                    let shape = {
                        ...newShapeProps,
                        x: newShapeProps.x + 5,
                        y: newShapeProps.y + 5,
                        id: eleId
                    }
                    let imagesToUpdate = images;
                    imagesToUpdate.push(shape);
                    setImages(JSON.parse(JSON.stringify(imagesToUpdate)));// Comment translated to English.
                    imagesRef.current = JSON.parse(JSON.stringify(imagesToUpdate));
                    history.push(imagesToUpdate);
                    setChart(imagesRef.current, selectedIdRef.current, null);

                    setSelectedId(null);
                    setDragShape(null);
                    setTimeout(() => {
                        setDragShape(shape);// Comment translated to English.
                        setSelectedId(shape.id)// Comment translated to English.
                        selectedIdRef.current = shape.id;
                    })
                    console.log(t('auto.k0363'));
                }
                break;
            case 'del': {
                // 删除目标元素；若属于组合，则整组一起删
                const delIds = new Set(getExpandedSelectionIds(newShapeProps.id));
                if (delIds.size === 0) delIds.add(newShapeProps.id);
                const delImageToUpdate = imagesRef.current.filter((img) => !delIds.has(img.id));
                setImages(JSON.parse(JSON.stringify(delImageToUpdate)));
                imagesRef.current = JSON.parse(JSON.stringify(delImageToUpdate));
                history.push(delImageToUpdate);
                setChart(imagesRef.current, selectedIdRef.current, null);

                selectShapes([]);
                selectedIdsRef.current = [];
                setSelectedId(null);
                selectedIdRef.current = null;
                setDragShape(null);
                console.log(t('auto.k0364'));
                break;
            }
            case 'lock':
            case 'unlock':
                handleShapeChange(newShapeProps, newShapeProps.id);
                console.log(t('auto.k0365'));
                break;
            default: console.log(t('auto.k0366')); break;
        }
        settoolType(null);
    };
    // Comment translated to English.
    const handleMultiToolBack = (type) => {
        // 关键：先把 Konva 节点真实位置同步回 imagesRef，避免对齐 / 等距 / 复制基于错位的 imagesRef 计算，
        // 导致视觉上"看似对齐"但保存到 chart 的 x/y 偏移、刷新后又错位的现象。
        // del 也要同步，否则删除前临时偏移会丢失（虽然下面 del 分支立即 return，不会读 x/y，但保持调用一致更安全）。
        syncKonvaPositionsToImagesRef();
        // 多选删除：批量删除 selectedIds（组合点击后 selectedIds 已含整组）
        if (type === 'del') {
            const delIds = new Set(selectedIdsRef.current);
            if (delIds.size === 0) {
                settoolType(null);
                return;
            }
            const nextImages = imagesRef.current.filter((img) => !delIds.has(img.id));
            setImages(JSON.parse(JSON.stringify(nextImages)));
            imagesRef.current = JSON.parse(JSON.stringify(nextImages));
            history.push(JSON.parse(JSON.stringify(imagesRef.current)));
            setChart(imagesRef.current, selectedIdRef.current, null);
            selectShapes([]);
            selectedIdsRef.current = [];
            setSelectedId(null);
            selectedIdRef.current = null;
            setDragShape(null);
            settoolType(null);
            return;
        }
        // F7+ Unit 模型：把同 groupId 成员折成一个 unit，按 unit 计算对齐目标，再把 offset
        // 应用到 unit 全部成员上，确保组合作为整体平移、内部相对位置不变。
        const tr = transformRefids.current;
        const unlockedSelectedIds = getUnlockedSelectedIds();
        const alignmentUnits = getAlignmentUnits(unlockedSelectedIds);
        if (!tr || alignmentUnits.length === 0) {
            settoolType(null);
            return;
        }

        // 锚点：以"用户最先选中的元素 / 组合"为参考线，对齐时锚点不动，其他 unit 向锚点对齐
        // alignmentUnits[0] 来自 selectedIds[0]，正好是用户首选项；如果首选项是组合，整组作为一个 unit
        const anchorMetrics = alignmentUnits[0].metrics;
        const xl = anchorMetrics.x;                                   // 锚点左边
        const xr = anchorMetrics.x + anchorMetrics.width;             // 锚点右边
        const yt = anchorMetrics.y;                                   // 锚点上边
        const yb = anchorMetrics.y + anchorMetrics.height;            // 锚点下边
        const xr2 = anchorMetrics.x + anchorMetrics.width / 2;        // 锚点水平中线
        const yt2 = anchorMetrics.y + anchorMetrics.height / 2;       // 锚点垂直中线

        // equal 系列：以 unit（组合外包盒 / 单元素外包盒）为粒度统计 maxw/maxh
        let maxh = 0, maxw = 0;
        if (type.indexOf('equal') >= 0) {
            alignmentUnits.forEach((unit) => {
                if (maxh < unit.metrics.height) maxh = unit.metrics.height;
                if (maxw < unit.metrics.width) maxw = unit.metrics.width;
            });
        }

        // 排序：水平等距按 x 升序、垂直等距按 y 升序，其它对齐保持 units 原顺序
        let orderedUnitKeys = [];
        if (type === 'equallevel') {
            orderedUnitKeys = [...alignmentUnits]
                .sort((a, b) => a.metrics.x - b.metrics.x)
                .map((u) => u.key);
        } else if (type === 'equalvertical') {
            orderedUnitKeys = [...alignmentUnits]
                .sort((a, b) => a.metrics.y - b.metrics.y)
                .map((u) => u.key);
        } else {
            orderedUnitKeys = alignmentUnits.map((u) => u.key);
        }

        // 等距：按 unit 计算每个 unit 的目标坐标
        const equalLevelTargets = type === 'equallevel'
            ? getDistributedUnitTargets(alignmentUnits, 'x') : {};
        const equalVerticalTargets = type === 'equalvertical'
            ? getDistributedUnitTargets(alignmentUnits, 'y') : {};

        // 复制：按 unit 收集 groupId 重映射，确保同一组的成员复制后仍属于同一新组
        const copyGroupIdMap = {};
        if (type === 'copys') {
            unlockedSelectedIds.forEach((sid) => {
                const src = imagesRef.current.find((img) => img.id === sid);
                if (src && src.groupId && !copyGroupIdMap[src.groupId]) {
                    copyGroupIdMap[src.groupId] = createDerivedGroupId(src.groupId);
                }
            });
        }

        const unitMap = {};
        alignmentUnits.forEach((u) => { unitMap[u.key] = u; });

        const copyids = [];
        const nextImages = JSON.parse(JSON.stringify(imagesRef.current));

        orderedUnitKeys.forEach((unitKey) => {
            const unit = unitMap[unitKey];
            if (!unit) return;
            const width = unit.metrics.width;
            const height = unit.metrics.height;

            // 1. 先按 unit 算出整体目标坐标（unit 外包盒左上角应该到哪）
            let targetX = unit.metrics.x;
            let targetY = unit.metrics.y;
            switch (type) {
                case 'alginleft':     targetX = xl;             break;
                case 'alginright':    targetX = xr - width;     break;
                case 'algintop':      targetY = yt;             break;
                case 'alginbottom':   targetY = yb - height;    break;
                case 'alginvertical': targetX = xr2 - width / 2;  break;
                case 'algincenter':   targetY = yt2 - height / 2; break;
                case 'equallevel':
                    if (equalLevelTargets[unit.key] !== undefined) targetX = equalLevelTargets[unit.key];
                    break;
                case 'equalvertical':
                    if (equalVerticalTargets[unit.key] !== undefined) targetY = equalVerticalTargets[unit.key];
                    break;
                default: break;
            }
            const offsetX = targetX - unit.metrics.x;
            const offsetY = targetY - unit.metrics.y;

            // 2. 把 offset / scale / 复制 应用到 unit 内全部成员（组合作为整体平移）
            unit.memberIds.forEach((memberId) => {
                const findIndex = nextImages.findIndex((img) => img.id === memberId);
                if (findIndex === -1) return;
                let singleImageToUpdate = JSON.parse(JSON.stringify(nextImages[findIndex]));
                switch (type) {
                    case 'copys': {
                        const eleId = parseInt(new Date().getTime()).toString() + copyids.length;
                        singleImageToUpdate = {
                            ...singleImageToUpdate,
                            x: singleImageToUpdate.x + 5,
                            y: singleImageToUpdate.y + 5,
                            id: eleId,
                            groupId: singleImageToUpdate.groupId
                                ? (copyGroupIdMap[singleImageToUpdate.groupId] || null)
                                : null,
                        };
                        copyids.push(eleId);
                        nextImages.push(singleImageToUpdate);
                        console.log(t('auto.k0373'));
                        break;
                    }
                    case 'equalhight': {
                        if (height !== 0 && maxh !== height) {
                            const scaleY = (singleImageToUpdate.scaleY || 1) * (maxh / height);
                            singleImageToUpdate = { ...singleImageToUpdate, scaleY };
                        }
                        nextImages[findIndex] = singleImageToUpdate;
                        console.log(t('auto.k0380'));
                        break;
                    }
                    case 'equalwidth': {
                        if (width !== 0 && maxw !== width) {
                            const scaleX = (singleImageToUpdate.scaleX || 1) * (maxw / width);
                            singleImageToUpdate = { ...singleImageToUpdate, scaleX };
                        }
                        nextImages[findIndex] = singleImageToUpdate;
                        console.log(t('auto.k0381'));
                        break;
                    }
                    case 'equal': {
                        const next = { ...singleImageToUpdate };
                        if (height !== 0 && maxh !== height) next.scaleY = (singleImageToUpdate.scaleY || 1) * (maxh / height);
                        if (width !== 0 && maxw !== width) next.scaleX = (singleImageToUpdate.scaleX || 1) * (maxw / width);
                        nextImages[findIndex] = next;
                        console.log(t('auto.k0382'));
                        break;
                    }
                    default: {
                        // 对齐 / 等距：组合所有成员同步偏移，相对位置保持
                        if (offsetX !== 0 || offsetY !== 0) {
                            singleImageToUpdate = {
                                ...singleImageToUpdate,
                                x: singleImageToUpdate.x + offsetX,
                                y: singleImageToUpdate.y + offsetY,
                            };
                        }
                        nextImages[findIndex] = singleImageToUpdate;
                        if (type === 'alginleft') console.log(t('auto.k0374'));
                        else if (type === 'alginright') console.log(t('auto.k0375'));
                        else if (type === 'algintop') console.log(t('auto.k0376'));
                        else if (type === 'alginbottom') console.log(t('auto.k0377'));
                        else if (type === 'alginvertical') console.log(t('auto.k0378'));
                        else if (type === 'algincenter') console.log(t('auto.k0379'));
                        else if (type === 'equalvertical') console.log(t('auto.k0383'));
                        else if (type === 'equallevel') console.log(t('auto.k0384'));
                        break;
                    }
                }
            });
        });

        setImages(JSON.parse(JSON.stringify(nextImages)));
        imagesRef.current = JSON.parse(JSON.stringify(nextImages));
        history.push(JSON.parse(JSON.stringify(imagesRef.current)));
        setChart(imagesRef.current, selectedIdRef.current, null);
        if (type === 'copys') {
            selectShapes(copyids);
            selectedIdsRef.current = copyids;
        }
        settoolType(null);
    }
    // Comment translated to English.
    const handleToolChange = async (type) => {
        if (type === 'undo') {
            if (history.length <= 1) {
                return;
            }
            history = history.slice(0, -1);
            const previous = JSON.parse(JSON.stringify(history[history.length - 1]));
            setImages(previous);
            imagesRef.current = previous;
            onClickTap('handle');
            setChart(imagesRef.current, selectedIdRef.current, null);
        } else {
            // Comment translated to English.
            if (selectedIdRef.current !== null || selectedIdsRef.current.length !== 0) {
                if (selectedIdsRef.current.length !== 0) {
                    if (type === 'copy') {
                        settoolType('copys');
                        handleMultiToolBack('copys');
                    } else {
                        handleMultiToolBack(type);
                    }
                } else {
                    settoolType(type);
                }
            }
        }
    };
    // Comment translated to English.
    const addToBackground = (backgroundUrl) => {
        setBackgroundImage(backgroundUrl);
    };
    // Comment translated to English.
    const savePage = async (type) => {
        // 关键：保存前先把 Konva 节点真实位置同步回 imagesRef，确保保存到 chart 的 x/y
        // 永远等于视觉看到的位置。否则复制后视觉上对，但保存的是 imagesRef 的旧 x/y，
        // 刷新加载后元素位置与保存时视觉不一致 → 复制体错位。
        syncKonvaPositionsToImagesRef();
        stagejson = stageRef.current.toJSON();
        let newjson = JSON.parse(stagejson);
        const shapeMap = {};
        imagesRef.current.forEach((shape) => {
            shapeMap[shape.id] = shape;
        });
        if (newjson && newjson.children && newjson.children[0] && Array.isArray(newjson.children[0].children)) {
            newjson.children[0].children.forEach(element => {// Comment translated to English.
                if (element.attrs.id === 'canvasBackground') {
                    if (backgroundImage && backgroundImage.indexOf('#') === -1) {
                        if (backgroundImage.indexOf('/public/') > 0) {
                            element.attrs.fillPatternImage = backgroundImage.split('/public/')[1];
                        } else {
                            element.attrs.fillPatternImage = backgroundImage;
                        }
                    }
                    element.attrs.alarmCatch = alarmCatchRef.current;
                    return;
                }
                const currentShape = shapeMap[element.attrs.id];
                if (currentShape) {
                    element.attrs = JSON.parse(JSON.stringify(currentShape));
                }
            });
        }
        stagejson = JSON.stringify(newjson);
        if (type === 'preview') {// Comment translated to English.
            localStorage.setItem('stageJson', JSON.stringify(stagejson));
            window.open(httpsend.viewURL() + 'preview.html?type=preview');
        }
        if (type === 'tpl') {// Comment translated to English.
            if (!saveTplName) {
                message.error(t('auto.k0441'));
                return false;
            }
            return JSON.stringify(stagejson);
        }

        if (type === 'page') {// Comment translated to English.
            if (!savePageId || savePageId === '0') {
                message.error(t('auto.k0442'));
                return false;
            }
            setIsModalOpen(true);
            seteditModalOpen(false);
        }
        if (type === 'editpage') {// Comment translated to English.
            if (savePageId && savePageId !== '0') {// Comment translated to English.
                setIsModalOpen(true);
                seteditModalOpen(true);
            } else {
                setIsModalOpen(false);
                seteditModalOpen(false);
                newPage();
            }
        }
    }

    // Comment translated to English.
    const newPage = () => {
        setsavePageId('0');
        setsavePageType();
        setsavePageTxt();
        setsavePageName();
        setsavePagePid();
        setsavePageIndex();
        setsavePageLink();
        setshowsavePageBox(1);
        setstageWidth(1920);
        setstageHeight(1080);
        setStageDimensions({
            width: 1920,
            height: 1080,
            scalex: 1,
            scaley: 1,
        });
        setcanvasScale(100);
        // 新建页面 → 换新 token（用于跨页面复制粘贴判定）
        currentPageTokenRef.current = 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    }
    // Comment translated to English.
    const loginOut = () => {
        localStorage.clear();
        window.location.href = httpsend.mainURL() + 'login.html';
    }
    // Comment translated to English.
    const handleCanvasChange = (val) => {
        setStageDimensions({
            scalex: val / 100,
            scaley: val / 100,
        });
        setcanvasScale(val);
    }
    // Comment translated to English.
    return (
        <>
            {!isPreview &&
                <>
                    <div className="top">
                        <div className="topLeft">
                            <label>{t('auto.k0387')}</label>
                        </div>
                        <div className="topCenter">
                            <div className="topGroup topToolList">
                                <ToolList
                                    MultiSelect={selectedIds.length !== 0}
                                    handleTool={(type) => {
                                        handleToolChange(type);
                                    }} />
                            </div>
                            <div className="topGroup topControls">
                                <Button type={snapEnabled ? 'primary' : 'default'} onClick={() => {
                                    setSnapEnabled((prev) => {
                                        if (prev) clearSnapGuides();
                                        return !prev;
                                    });
                                }}>{snapEnabled ? '磁吸开' : '磁吸关'}</Button>
                                <select className="topControl" value={String(snapThreshold)} onChange={(e) => setSnapThreshold(Number(e.target.value))}>
                                    <option value="4">4px</option>
                                    <option value="6">6px</option>
                                    <option value="8">8px</option>
                                    <option value="10">10px</option>
                                </select>
                                <Button type="default" disabled={!canGroupSelection} onClick={groupSelectedShapes}>组合</Button>
                                <Button type="default" disabled={!canUngroupSelection} onClick={ungroupSelectedShapes}>取消组合</Button>
                            </div>
                        </div>
                        <div className="topRight">
                            <span className={`saveStatus ${saveStatusText === '已修改' ? 'dirty' : ''}`}>{saveStatusText === '已自动保存' && lastAutoSaveTime ? `${saveStatusText} · ${lastAutoSaveTime}` : saveStatusText}</span>
                            <Button type="primary" className="topActionBtn" onClick={() => setIsOutOpen(true)}>{t('auto.k0388')}</Button>
                            {(savePageId !== '0' && savePageType === '1') && <Button type="primary" className="topActionBtn" onClick={() => savePage('preview')}>{t('auto.k0389')}</Button>}
                            {(savePageId !== '0' && savePageType === '1') && <Button type="primary" className="topActionBtn" onClick={() => setshowsaveTplBox(1)}>{t('auto.k0390')}</Button>}
                            {(savePageId !== '0' && savePageType === '1') && <Button type="primary" className="topActionBtn" onClick={() => savePage('page')}>{t('auto.k0391')}</Button>}
                            <Button type="primary" className="topActionBtn" onClick={() => savePage('editpage')}>{t('auto.k0392')}</Button>
                            {(savePageId !== '0' && savePageType === '1') && <Button type="primary" className="topActionBtn" onClick={() => setresetBox(true)}>{t('auto.k0393')}</Button>}
                        </div>
                    </div>
                    <ItemBox
                        onChangeDragUrl={handleItemDragUrl}
                        isChanged={savePageId} />
                    <div className="eleAttrs">
                        <ul>
                            <li className={`${showIndex === 1 ? 'check' : ''} ${tabFlash === 'component' ? 'tabFlash' : ''}`.trim()} onClick={() => setshowIndex(1)}>{t('auto.k0394')}</li>
                            <li className={showIndex === 2 ? 'check' : ''} onClick={() => setshowIndex(2)}>{t('auto.k0395')}</li>
                            <li className={showIndex === 3 ? 'check' : ''} onClick={() => setshowIndex(3)}>界面属性</li>
                        </ul>
                        {showIndex === 1 &&
                            <ElementAttr
                                MultiSelect={selectedIds.length !== 0}
                                dragShape={dragShape}
                                onChange={(dragShape, clickEvnt) => {
                                    handleShapeChange(dragShape, clickEvnt);
                                }} />}
                        {showIndex === 2 &&
                            <><ElementSvg
                                imgUrl={backgroundImage}
                                alarmCatch={alarmCatch}
                                onSelChange={(val) => {
                                    setalarmCatch(val);
                                    alarmCatchRef.current = val;
                                }}
                                onChange={(backgroundUrl) => {
                                    addToBackground(backgroundUrl);
                                }} />
                            </>}
                        {showIndex === 3 && (() => {
                            const structure = getInterfaceStructure();
                            return (
                                <div className="interfaceAttrs">
                                    <div className="attrTitle">未组合元素</div>
                                    {structure.singles.length === 0 && <div className="attrBox">暂无未组合元素</div>}
                                    {structure.singles.map((item) => (
                                        <div
                                            key={item.id}
                                            className="attrBox interfaceItem"
                                            onMouseEnter={() => setHoverHighlightIds([item.id])}
                                            onMouseLeave={() => setHoverHighlightIds([])}
                                            onClick={() => handleStructureItemClick(item.id, false)}
                                        >
                                            <label>{item.label}</label>
                                            <span>{item.id}</span>
                                        </div>
                                    ))}
                                    <div className="attrTitle">组合元素</div>
                                    {structure.groups.length === 0 && <div className="attrBox">暂无组合</div>}
                                    {structure.groups.map((group) => (
                                        <div key={group.groupId} className="interfaceGroup">
                                            <div
                                                className="attrBox interfaceGroupHeader"
                                                onMouseEnter={() => setHoverHighlightIds(group.members.map((m) => m.id))}
                                                onMouseLeave={() => setHoverHighlightIds([])}
                                                onClick={() => handleStructureItemClick(group.members.length > 0 ? group.members[0].id : '', true)}
                                            >
                                                <label>{group.label}</label>
                                                <span>{group.members.length} 个元素</span>
                                            </div>
                                            {group.members.map((item) => (
                                                <div
                                                    key={item.id}
                                                    className="attrBox interfaceItem interfaceGroupMember"
                                                    onMouseEnter={() => setHoverHighlightIds([item.id])}
                                                    onMouseLeave={() => setHoverHighlightIds([])}
                                                    onClick={() => handleStructureItemClick(item.id, true)}
                                                >
                                                    <label>{item.label}</label>
                                                    <span>{item.id}</span>
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                    <div
                        className="canvasBody"
                        style={{ 'backgroundColor': '#eee' }}
                        ref={containerRef}
                        onDrop={handleOnDrop}
                        onDragOver={(e) => e.preventDefault()}
                    >
                        <div className="canvasRange">
                            <img src="Images/icon/narrow.png" style={{ 'width': '15px', 'verticalAlign': 'super', 'marginRight': '5px' }} alt={t('auto.k0329')} />
                            <input type="range" min="10" max="100" onChange={(e) => handleCanvasChange(e.target.value)} defaultValue={canvasScale} />
                            <img src="Images/icon/enlarge.png" style={{ 'width': '15px', 'verticalAlign': 'super', 'marginLeft': '5px' }} alt={t('auto.k0330')} />
                        </div>
                        {savePageId === '0' && <Stage
                            className="canvasStage canvasStage2"
                            width={safeStageWidth}
                            height={safeStageHeight}
                            scaleX={stageDimensions.scalex}
                            scaleY={stageDimensions.scaley}
                            ref={stageRef}
                        >
                            <Layer ref={layerRef} style={{ 'backgroundColor': '#fff' }}>
                                <Group>
                                    <Text text={t('auto.k0331')} fontSize={25} lineHeight={5} padding={50} />
                                </Group>
                            </Layer>
                        </Stage>}
                        {savePageId !== '0' && (savePageType === '1' ? <Stage
                            className="canvasStage canvasStage2"
                            width={safeStageWidth}
                            height={safeStageHeight}
                            scaleX={stageDimensions.scalex}
                            scaleY={stageDimensions.scaley}
                            ref={stageRef}
                            onClick={onClickTap}
                            onTap={onClickTap}
                            onMouseDown={onMouseDown}
                            onMouseUp={onMouseUp}
                            onMouseMove={onMouseMove}
                            key='stage001'
                        >
                            <Layer ref={layerRef} style={{ 'backgroundColor': '#fff' }}>
                                {(backgroundImage && typeof backgroundImage === "string") && (
                                    <SvgBackground
                                        backgroundUrl={backgroundImage}
                                        width={safeStageWidth}
                                        height={safeStageHeight} />
                                )}
                                {images.map((shape) => {
                                    const isUnlocked = shape.draggable !== false;
                                    const isPrimarySelected = isUnlocked && shape.id === selectedId && selectedIds.length === 0;
                                    const hasSelectionFrame = isUnlocked && (selectedIds.includes(shape.id) || marqueeHoverIds.includes(shape.id) || (shape.id === selectedId && selectedIds.length === 0));
                                    const isElementHover = hoverElementIds.includes(shape.id);
                                    const isAlignmentAnchor = alignmentAnchorIds.includes(shape.id);
                                    return (<ConElement
                                        id={shape.id}
                                        key={shape.id}
                                        shapeProps={shape}
                                        isSelected={isPrimarySelected}
                                        showSelectionFrame={hasSelectionFrame}
                                        isAlignmentAnchor={isAlignmentAnchor}
                                        isHoverHighlighted={hoverHighlightIds.includes(shape.id)}
                                        isElementHover={isElementHover}
                                        onHoverEnter={(s) => {
                                            // 拖动期间禁用 hover 状态更新，避免 setState 触发 React 重渲染把同组成员的 Konva 节点回拉到旧位置
                                            if (multiDragRef.current.active) return;
                                            // 锁定元素：只亮自身红边，不联动组
                                            if (s.draggable === false) {
                                                setHoverElementIds([s.id]);
                                                return;
                                            }
                                            // 未锁定元素：整组联动，但过滤掉组内锁定成员
                                            const groupIds = getExpandedSelectionIds(s.id).filter((id) => {
                                                const member = imagesRef.current.find((m) => m.id === id);
                                                return member && member.draggable !== false;
                                            });
                                            setHoverElementIds(groupIds.length > 0 ? groupIds : [s.id]);
                                        }}
                                        onHoverLeave={() => {
                                            if (multiDragRef.current.active) return;
                                            setHoverElementIds([]);
                                        }}
                                        toolType={shape.id === selectedId ? toolType : null}
                                        onToolBack={(newShapeProps, type) => {
                                            handleToolBack(newShapeProps, type);
                                        }}
                                        onDragStart={(e, currentShape) => handleShapeDragStart(e, currentShape)}
                                        onDragMove={(e, currentShape) => handleShapeDragMove(e, currentShape)}
                                        onSelect={(evt) => {
                                            // Ctrl / Cmd：交给 onClickTap 走多选逻辑
                                            if (evt && evt.evt && (evt.evt.ctrlKey || evt.evt.metaKey)) {
                                                return;
                                            }
                                            // 拖动开始：dragmove 懒初始化 multiDragRef，这里跳过 setState 避免 React 重渲染拽回 Konva 节点
                                            if (evt && evt.evt && evt.evt.__draggingSelection) {
                                                return;
                                            }
                                            // 组合成员被点中：整组同步纳入 selectedIds（按组整体选中）
                                            const groupSelectionIds = getExpandedSelectionIds(shape.id);
                                            if (groupSelectionIds.length > 1) {
                                                // 已经是同样的整组在选中：跳过 setState，避免重渲染回拉拖动中的 Konva 节点
                                                const same = selectedIdsRef.current.length === groupSelectionIds.length
                                                    && groupSelectionIds.every((id) => selectedIdsRef.current.includes(id));
                                                if (same && selectedIdRef.current === shape.id) {
                                                    return;
                                                }
                                                selectShapes(groupSelectionIds);
                                                selectedIdsRef.current = groupSelectionIds;
                                                setSelectedId(shape.id);
                                                selectedIdRef.current = shape.id;
                                                setDragShape(shape);
                                                return;
                                            }
                                            // 普通单元素：保持原有单选行为
                                            if (selectedId !== shape.id) {
                                                setSelectedId(null);
                                                setDragShape(null);
                                                selectShapes([]);
                                                selectedIdsRef.current = [];
                                                setTimeout(() => {
                                                    setSelectedId(shape.id);
                                                    selectedIdRef.current = shape.id;
                                                    setDragShape(shape);
                                                });
                                            }
                                        }}
                                        onChange={(newShapeProps) => {
                                            // 多选拖动 dragend：跟随成员 (非被拖那个) 的 onChange 直接 return，
                                            // 避免每个成员都 push 一次 history 导致撤销要按 N 次
                                            if (pendingDragFollowerIdsRef.current.has(shape.id)) {
                                                pendingDragFollowerIdsRef.current.delete(shape.id);
                                                return;
                                            }
                                            // 多选拖动：被拖元素的 onChange 优先把 pendingPositions 一次性 commit，避免单点 handleShapeChange 把整组带歪
                                            if (multiDragRef.current.active && multiDragRef.current.draggedId === shape.id && multiDragRef.current.pendingPositions) {
                                                commitMultiDragPositions(multiDragRef.current.pendingPositions);
                                                multiDragRef.current = {
                                                    active: false,
                                                    draggedId: null,
                                                    startPositions: {},
                                                    pendingPositions: null,
                                                };
                                                // 被拖元素已 commit，剩余 follower 不需要再保留追踪
                                                pendingDragFollowerIdsRef.current = new Set();
                                                clearSnapGuides();
                                                return;
                                            }
                                            handleShapeChange(newShapeProps, shape.id);
                                        }} />
                                    );
                                })}
                                {/* 磁吸引导线：始终渲染，由 ref imperative 控制 visible/points/样式，不触发 React 重渲染 */}
                                <Line
                                    ref={snapGuideVRef}
                                    visible={false}
                                    points={[0, 0, 0, 0]}
                                    stroke="#148cf1"
                                    strokeWidth={1}
                                    dash={[6, 4]}
                                    listening={false}
                                />
                                <Line
                                    ref={snapGuideHRef}
                                    visible={false}
                                    points={[0, 0, 0, 0]}
                                    stroke="#148cf1"
                                    strokeWidth={1}
                                    dash={[6, 4]}
                                    listening={false}
                                />
                                <Transformer
                                    ref={transformRefids}
                                    flipEnabled={false}
                                    // 参考 your-feature 分支：通过隐藏视觉元素让 Stage 级 Transformer 不显示边框/锚点，
                                    // 同时保留默认 listening=true 以保证 transformRefids.current.nodes(nodes) 正常工作。
                                    // 元素自己的边框由 ConElement 内部的 transformRef 单独绘制（多选每个成员各自显示）。
                                    // 之前用 listening={selectedIds.length<=1} 切换 listening 会破坏 Konva Transformer 内部
                                    // nodes 跟踪 / 事件 hook 链路，导致"先点击组合 → 再拖动 → 拖不动"。
                                    borderEnabled={false}
                                    anchorSize={0}
                                    rotateEnabled={false}
                                    boundBoxFunc={(oldBox, newBox) => getBoundedTransformerBox(oldBox, newBox)} />
                                <Rect fill="rgba(0,0,255,0.5)" ref={selectionRectRef} />
                            </Layer>
                        </Stage> : <Stage
                            className="canvasStage canvasStage2"
                            width={safeStageWidth}
                            height={safeStageHeight}
                            scaleX={stageDimensions.scalex}
                            scaleY={stageDimensions.scaley}
                            ref={stageRef}
                            key='stage002'
                        >
                            <Layer ref={layerRef} style={{ 'backgroundColor': '#fff' }}>
                                <Group>
                                    <Text text={t('auto.k0332')} fontSize={25} lineHeight={5} padding={50} />
                                </Group>
                            </Layer>
                        </Stage>)}
                    </div>
                    <div className="layui-layer" id="saveTpl" style={showsaveTplBox === 1 ? { 'display': 'block' } : { 'display': 'none' }}>
                        <div className="layui-layer-title">{t('auto.k0396')}</div>
                        <div className="layui-layer-content">
                            <div>
                                <label>{t('auto.k0397')}</label>
                                <input style={{ width: '167px' }} type="text" onChange={(e) => setsaveTplName(e.target.value)} value={saveTplName} />
                            </div>
                        </div>
                        <span className="layui-layer-setwin" onClick={() => setshowsaveTplBox(0)}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={async () => {
                                let savejson = await savePage('tpl');
                                let res = await httpsend.getDataLocal('saveTpl', { name: saveTplName, tplcon: savejson });
                                if (res) {
                                    message.success(t('auto.k0443')); setSavedStatus('已保存'); dirtyRef.current = false; cancelAutoSave();
                                }
                                setsaveTplName('');
                                setshowsaveTplBox(0);
                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                    <div className="layui-layer" id="savePage" style={showsavePageBox === 1 ? { 'display': 'block' } : { 'display': 'none' }} key={showsavePageBox}>
                        <div className="layui-layer-title">{t('auto.k0398')}</div>
                        <div className="layui-layer-content">
                            <div>
                                <label>{t('auto.k0399')}</label>
                                <select onChange={(e) => setsavePageType(e.target.value)} defaultValue={savePageType} style={{ 'width': '167px' }}>
                                    <option value=''>{t('auto.k0229')}</option>
                                    <option value='1'>{t('auto.k0400')}</option>
                                    <option value='2'>{t('auto.k0401')}</option>
                                    <option value='3'>{t('auto.k0402')}</option>
                                </select>
                            </div>
                            {savePageType === '1' && <div>
                                <label>{t('auto.k0403')}</label>
                                <input style={{ width: '76px' }} type="text" onChange={(e) => setstageWidth(normalizeStageSize(e.target.value, safeStageWidth))} defaultValue={stageWidth} />
                                <span> * </span>
                                <input style={{ width: '76px' }} type="text" onChange={(e) => setstageHeight(normalizeStageSize(e.target.value, safeStageHeight))} defaultValue={stageHeight} />
                            </div>}
                            <div>
                                <label>{t('auto.k0404')}</label>
                                <input style={{ width: '167px' }} type="text" onChange={(e) => setsavePageName(e.target.value)} defaultValue={savePageName} />
                            </div>
                            <div>
                                <label>{t('auto.k0405')}</label>
                                <Cascader options={savePagePidSel} onChange={(val) => setsavePagePid(val[val.length - 1])} changeOnSelect style={{ 'width': '167px' }} />
                            </div>
                            <div>
                                <label>{t('auto.k0406')}</label>
                                <input style={{ width: '167px' }} type="number" onChange={(e) => setsavePageIndex(e.target.value)} defaultValue={savePageIndex} />
                            </div>
                            {savePageType === '3' && <div>
                                <label>{t('auto.k0407')}</label>
                                <input style={{ width: '167px' }} type="text" onChange={(e) => setsavePageLink(e.target.value)} defaultValue={savePageLink} />
                            </div>}
                        </div>
                        <span className="layui-layer-setwin" onClick={() => setshowsavePageBox(0)}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={async () => {
                                if (!savePageType) {
                                    message.error(t('auto.k0408'));
                                    return;
                                }
                                if (!savePageName) {
                                    message.error(t('auto.k0409'));
                                    return;
                                }
                                if (!savePagePid) {
                                    message.error(t('auto.k0410'));
                                    return;
                                }
                                if (!savePageIndex) {
                                    message.error(t('auto.k0411'));
                                    return;
                                }
                                if (savePageType === '3' && !savePageLink) {
                                    message.error(t('auto.k0412'));
                                    return;
                                }
                                let savefilename = (new Date().getTime()).toString();
                                let res = await httpsend.getData('CreateDmpageKey', {
                                    PageType: savePageType,
                                    PageName: savePageName,
                                    pid: savePagePid,
                                    PageIndex: savePageIndex,
                                    ProId: 0,
                                    PageTop: -1,
                                    PageTxt: savePageType === '3' ? savePageLink : savefilename,
                                });
                                if (res.code === 100) {
                                    console.log(t('auto.k0413'))
                                    setStageDimensions({
                                        width: stageWidth,
                                        height: stageHeight,
                                        scalex: 1,
                                        scaley: 1,
                                    });
                                    setcanvasScale(100);
                                    setsavePageId(res.data.id);
                                    setsavePageTxt(res.data.PageTxt);
                                    multiDragRef.current = {
                                        active: false,
                                        draggedId: null,
                                        startPositions: {},
                                        pendingPositions: null,
                                    };
                                    clearSnapGuides();
                                    selectShapes([]);
                                    selectedIdsRef.current = [];
                                    setSelectedId(null);
                                    selectedIdRef.current = null;
                                    setDragShape(null);
                                    settoolType(null);
                                    setHoverHighlightIds([]);
                                    setImages([]);
                                    setBackgroundImage(null);
                                    setalarmCatch('1')
                                    alarmCatchRef.current = '1';
                                    imagesRef.current = [];
                                    setChart(JSON.parse(JSON.stringify(imagesRef.current)), null, null);
                                    history = [];
                                    if (savePageType === '1') {// Comment translated to English.
                                        let fileres = await httpsend.getDataLocal('savePage', { name: savefilename, pagecon: JSON.stringify(stageRef.current.toJSON()) });
                                        if (fileres.code === 100) {
                                            message.success(t('auto.k0443')); setSavedStatus('已保存'); dirtyRef.current = false; cancelAutoSave();
                                        } else {
                                            message.error(t('auto.k0444'));
                                        }
                                    } else {
                                        message.success(t('auto.k0443')); setSavedStatus('已保存'); dirtyRef.current = false; cancelAutoSave();
                                    }
                                } else {
                                    message.error(t('auto.k0445'));
                                }
                                setshowsavePageBox(0);
                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                    <div className="layui-layer" style={isModalOpen ? { 'display': 'block' } : { 'display': 'none' }}>
                        <div className="layui-layer-title">{t('auto.k0218')}</div>
                        {!editModalOpen && <div className="layui-layer-content">{t('auto.k0414')}<span style={{ color: '#148cf1', fontSize: 18 }}>《{savePageName}》</span>{t('auto.k0415')}</div>}
                        {editModalOpen && <div className="layui-layer-content">{t('auto.k0416')}<span style={{ color: '#148cf1', fontSize: 18 }}>《{savePageName}》</span>{t('auto.k0417')}</div>}
                        <span className="layui-layer-setwin" onClick={() => {
                            if (editModalOpen) {// Comment translated to English.
                                newPage()
                            }
                            setIsModalOpen(false);
                            seteditModalOpen(false);
                        }}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={async () => {
                                let savejson = JSON.stringify(stagejson);
                                // let savefilename = (new Date().getTime()).toString();
                                // Comment translated to English.
                                if (savePageId && savePageName) {
                                    let params = {
                                        id: savePageId
                                    }
                                    // if (savePageType === '1') params.PageTxt = savefilename;
                                    let res = await httpsend.getData('ChangeDmpageKey', params);
                                    if (res.code === 100) {
                                        // Comment translated to English.
                                        if (savePageType === '1') {
                                            let res2 = await httpsend.getDataLocal('savePage', { name: savePageTxt, pagecon: savejson });
                                            if (res2.code === 100) {
                                                message.success(t('auto.k0443')); setSavedStatus('已保存'); dirtyRef.current = false; cancelAutoSave();
                                            } else {
                                                message.error(t('auto.k0444'));
                                            }
                                        } else {
                                            message.success(t('auto.k0443')); setSavedStatus('已保存'); dirtyRef.current = false; cancelAutoSave();
                                        }
                                    } else {
                                        message.error(t('auto.k0445'));
                                    }
                                } else {
                                    message.error(t('auto.k0446'));
                                }
                                if (editModalOpen) {
                                    newPage()
                                }
                                setIsModalOpen(false);
                                seteditModalOpen(false);
                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                    <div className="layui-layer" style={isOutOpen ? { 'display': 'block' } : { 'display': 'none' }}>
                        <div className="layui-layer-title">{t('auto.k0218')}</div>
                        <div className="layui-layer-content">{t('auto.k0418')}</div>
                        <span className="layui-layer-setwin" onClick={() => setIsOutOpen(false)}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={async () => {
                                setIsOutOpen(false);
                                loginOut();
                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                    {/* Comment translated to English. */}
                    <div className="layui-layer" style={resetBox ? { 'display': 'block' } : { 'display': 'none' }}>
                        <div className="layui-layer-title">{t('auto.k0419')}</div>
                        <div className="layui-layer-content">
                            {pagedevList.length > 0 && pagedevList.map((el) => {
                                return (<><div style={{ width: '50%', 'float': 'left' }}>
                                    <label style={{ width: '60px' }}>{t('auto.k0420')}</label>
                                    <input defaultValue={el.label} readOnly style={{ 'width': 'calc(100% - 70px)' }} />
                                </div>
                                    <div style={{ width: '50%', 'float': 'right' }}>
                                        <label style={{ width: '60px' }}>{t('auto.k0421')}</label>
                                        <Select
                                            showSearch
                                            placeholder={t('auto.k0230')}
                                            optionFilterProp="children"
                                            onChange={(val) => {
                                                if (val) {
                                                    el.newid = val
                                                }
                                            }}
                                            onSearch={ondataDevOptionSearch}
                                            filterOption={filterOption}
                                            options={el.children}
                                            style={{ 'width': 'calc(100% - 60px)' }}
                                        />
                                    </div></>)
                            })}
                            {pagedevList.length === 0 && <span>{t('auto.k0422')}</span>}
                        </div>
                        <span className="layui-layer-setwin" onClick={() => setresetBox(false)}>
                            <Close />
                        </span>
                        <div className="layui-layer-btn">
                            <Button type="primary" onClick={async () => {
                                // console.log(pagedevList);
                                // Comment translated to English.
                                if (pagedevList.length !== 0) {
                                    let newimags = [];
                                    imagesRef.current.forEach(shapeProps => {
                                        if (shapeProps.moduleJson && shapeProps.moduleJson.attrs.dataKey) {
                                            let dataKey = shapeProps.moduleJson.attrs.dataKey;
                                            if (dataKey && dataKey.length === 1) {
                                                dataKey.forEach((el) => {
                                                    // Comment translated to English.
                                                    let findpagedevindex = pagedevList.findIndex(v => String(v.value) === String(el.key || el.deveventskey))
                                                    if (findpagedevindex !== -1 && pagedevList[findpagedevindex]['newid']) {
                                                        if (el.key) el.key = pagedevList[findpagedevindex]['newid'];
                                                        if (el.deveventskey) el.deveventskey = pagedevList[findpagedevindex]['newid'];
                                                    }
                                                })
                                            }
                                        }
                                        newimags.push(shapeProps);
                                    })

                                    setImages(newimags);
                                    imagesRef.current = newimags;
                                    setChart(JSON.parse(JSON.stringify(imagesRef.current)), null, null);
                                    history.push(JSON.parse(JSON.stringify(imagesRef.current)));
                                }
                                setresetBox(false);

                            }}>{t('auto.k0202')}</Button>
                        </div>
                    </div>
                </>
            }
            {isPreview && <div
                className="canvasBody"
                ref={containerRef}
                style={{ 'width': stageDimensions.width + 'px', 'height': stageDimensions.height + 'px' }}
            >
                <Stage
                    className="canvasStage"
                    width={stageDimensions.width}
                    height={stageDimensions.height}
                    scaleX={stageDimensions.scalex}
                    scaleY={stageDimensions.scaley}
                    ref={stageRef}
                    style={{ 'width': stageDimensions.width + 'px', 'height': stageDimensions.height + 'px', 'overflowX': 'hidden' }}
                >
                    <Layer ref={layerRef}>
                        {(backgroundImage && typeof backgroundImage === "string") && (
                            <SvgBackground
                                backgroundUrl={backgroundImage}
                                width={safeStageWidth}
                                height={safeStageHeight}
                            />
                        )}
                        {imagesstatic && imagesstatic.map((shape) => {
                            return (<PreviewElement
                                id={shape.id}
                                key={shape.id}
                                shapeProps={shape}
                                wheight={stageDimensions.height}
                                wwidth={stageDimensions.width}
                                wscale={stageDimensions.scalex}
                                onhandleResize={(type) => {
                                    if (type === 'full') {
                                        handleResize(stageWidthRef.current, stageHeightRef.current)
                                    }
                                }}
                                isSwiper={isSwiper}
                            />
                            );
                        })}
                        {imagesdata && imagesdata.map((shape) => {
                            return (<PreviewElement
                                id={shape.id}
                                key={shape.id}
                                shapeProps={shape}
                                wheight={stageDimensions.height}
                                wwidth={stageDimensions.width}
                                wscale={stageDimensions.scalex}
                                onhandleResize={(type) => { }}
                                isSwiper={isSwiper}
                            />
                            );
                        })}
                    </Layer>
                </Stage>
            </div>
            }
        </>
    );
}
export default Home;
