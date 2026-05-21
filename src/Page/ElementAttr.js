import React, { memo, useState, useEffect, useReducer, useRef, useCallback } from 'react';
import { Close, Lock, PermMedia } from '@mui/icons-material';
import httpsend from '../Assets/httpsend';
import { Select, Button } from 'antd';
import { t } from '../i18n';
// import { Select, Button, message } from 'antd';
// import GifImages from './Data/GifImages';
import debounce from 'lodash.debounce';

const ElementAttr = memo((props) => {
    if (props.MultiSelect) {
        return [<div className="attrLocked" key='123456'>
            <PermMedia fontSize="large" color="disabled" />
            <div>{t('auto.k0423')}</div>
        </div>
        ]
    }

    let dragShape = JSON.parse(JSON.stringify(props.dragShape));
    if (!dragShape || (dragShape && !dragShape.moduleJson)) {
        return [<div className="attrLocked" key='123456'>
            <PermMedia fontSize="large" color="disabled" />
            <div>{t('auto.k0424')}</div>
        </div>
        ]
    }
    // Comment translated to English.
    // console.log(dragShape);

    if (dragShape.draggable === false) {
        return [<div className="attrLocked" key={dragShape.id}>
            <Lock fontSize="large" color="disabled" />
            <div>{t('auto.k0425')}</div>
        </div>
        ]
    }

    let shapeId = dragShape.id;
    let shapeAttr = dragShape.moduleJson;// Comment translated to English.
    // Comment translated to English.
    let newparamDevId = null;
    let newparam = null;
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('key')) {
        newparamDevId = shapeAttr.attrs.dataKey[0].key + '&' + shapeAttr.attrs.dataKey[0].type + '/' + shapeAttr.attrs.dataKey[0].src
        // Comment translated to English.
        if (shapeAttr.attrs.dataKey[0].hasOwnProperty('name')) {
            newparam = shapeAttr.attrs.dataKey[0].name + '~' + shapeAttr.attrs.dataKey[0].type + '%' + shapeAttr.attrs.dataKey[0].cmdtype + '|' + shapeAttr.attrs.dataKey[0].src
        }
    }
    // Comment translated to English.
    let newparams = [];
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('devkey')) {
        shapeAttr.attrs.dataKey.forEach(element => {
            newparams.push(element.devkey + '&' + element.dev + '/' + element.name + '~' + element.type + '%' + element.cmdtype + '|' + element.src)
        });
    }
    // Comment translated to English.
    let newcusparams = [];
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('paramskey')) {
        shapeAttr.attrs.dataKey.forEach(element => {
            newcusparams.push(element.paramskey + '&' + element.name)
        });
    }
    // Comment translated to English.
    let newpages = [];
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('pagekey')) {
        shapeAttr.attrs.dataKey.forEach(element => {
            newpages.push(element.pagekey + '-' + element.name)
        });
    }
    // Comment translated to English.
    let newevents = [];
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('eventskey')) {
        shapeAttr.attrs.dataKey.forEach(element => {
            newevents.push(element.eventsdevname + '&' + element.eventskey + '/' + element.name + '~' + element.eventsdevkey + '%' + element.src)
        });
    }
    // Comment translated to English.
    let newdevevents = [];
    if (shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0 && shapeAttr.attrs.dataKey[0].hasOwnProperty('deveventskey')) {
        shapeAttr.attrs.dataKey.forEach(element => {
            newdevevents.push(element.deveventskey + '&' + element.type + '/' + element.src)
        });
    }
    // Comment translated to English.
    let newcommand = [];
    let newclicktype = 'order';
    if (dragShape.clickEvnt && dragShape.clickEvnt.length > 0) {
        if (dragShape.clickEvnt[0].hasOwnProperty('devkey')) {
            dragShape.clickEvnt.forEach(element => {
                newcommand.push(element.devkey + '/' + element.command + '/' + element.devname + '/' + element.desc + '/' + element.src)
            });
            newclicktype = 'order';
        }
        if (dragShape.clickEvnt[0].hasOwnProperty('weblink')) {
            newclicktype = 'weblink';
        }
        if (dragShape.clickEvnt[0].hasOwnProperty('link')) {
            newclicktype = 'link';
        }
        if (dragShape.clickEvnt[0].hasOwnProperty('newlink')) {
            newclicktype = 'newlink';
        }
        if (dragShape.clickEvnt[0].hasOwnProperty('videoChannel')) {
            newclicktype = 'videoChannel';
        }
        // if (dragShape.clickEvnt[0].hasOwnProperty('full')) {
        //     newclicktype = 'full';
        // }
        // if (dragShape.clickEvnt[0].hasOwnProperty('exitfull')) {
        //     newclicktype = 'exitfull';
        // }
    }

    let x, y, scaleX, scaleY, rotation;
    x = dragShape.x;// Comment translated to English.
    y = dragShape.y;// Comment translated to English.
    scaleX = dragShape.scaleX || 1;
    scaleY = dragShape.scaleY || 1;
    rotation = dragShape.rotation;

    let attrList = [];// Comment translated to English.
    const [devList, setdevList] = useState([]);// Comment translated to English.
    const [paramDevId, setparamDevId] = useState(newparamDevId);// Comment translated to English.

    const [commandList, setcommandList] = useState([]);// Comment translated to English.
    const [videoList, setvideoList] = useState([]);// Comment translated to English.
    const [command, setcommand] = useState(newcommand);// Comment translated to English.
    const [clickDesc, setclickDesc] = useState(dragShape.clickEvnt ? JSON.stringify(dragShape.clickEvnt) : null);// Comment translated to English.
    const [tipsVal, settipsVal] = useState(dragShape.tipsVal ? dragShape.tipsVal : 1);// Comment translated to English.

    const [paramsList, setparamsList] = useState([]);// Comment translated to English.
    const [params, setparams] = useState(newparams);// Comment translated to English.
    const [paramList, setparamList] = useState([]);// Comment translated to English.
    const [param, setparam] = useState(newparam);// Comment translated to English.

    const [cusparamList, setcusparamList] = useState([]);// Comment translated to English.
    const [cusparam, setcusparam] = useState((shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0) ? shapeAttr.attrs.dataKey[0].parkey : null);// Comment translated to English.
    const [cusparams, setcusparams] = useState(newcusparams);// Comment translated to English.
    const [cusparamsList, setcusparamsList] = useState([]);// Comment translated to English.

    const [ShowParaIndex, setShowParaIndex] = useState(0);// Comment translated to English.
    const [ShowParasIndex, setShowParasIndex] = useState(0);// Comment translated to English.

    const [pagesList, setpagesList] = useState([]);// Comment translated to English.
    const [pages, setpages] = useState(newpages);// Comment translated to English.

    const [eventsList, seteventsList] = useState([]);// Comment translated to English.
    const [ShowEventIndex, setShowEventIndex] = useState(0);// Comment translated to English.
    const [events, setevents] = useState(newevents);// Comment translated to English.
    const [devevents, setdevevents] = useState(newdevevents);// Comment translated to English.

    const [paramData, setparamData] = useState((shapeAttr.attrs.dataKey && shapeAttr.attrs.dataKey.length > 0) ? JSON.stringify(shapeAttr.attrs.dataKey) : null);// Comment translated to English.

    const [showDevBox, setshowDevBox] = useState(0);// Comment translated to English.
    const [showParamBox, setshowParamBox] = useState(0);// Comment translated to English.
    const [showParamsBox, setshowParamsBox] = useState(0);// Comment translated to English.
    const [showPagesBox, setshowPagesBox] = useState(0);// Comment translated to English.
    const [showEventsBox, setshowEventsBox] = useState(0);// Comment translated to English.

    const [showImgBox, setshowImgBox] = useState(0);// Comment translated to English.
    const [showGifImgBox, setshowGifImgBox] = useState(0);// Comment translated to English.
    const [showClickBox, setshowClickBox] = useState(0);// Comment translated to English.

    const [imgUrl, setimgUrl] = useState((shapeAttr.children.length > 0 && shapeAttr.children[0].className === 'Image') ? shapeAttr.children[0].attrs.image : null);// Comment translated to English.
    const [imgalarmUrl, setimgalarmUrl] = useState((shapeAttr.children.length > 0 && shapeAttr.children[0].className === 'Image') ? shapeAttr.children[0].attrs.alarmImage : null);// Comment translated to English.
    const [imgUrlId, setimgUrlId] = useState(0)// Comment translated to English.
    const [MyImages, setMyImages] = useState([]);// Comment translated to English.
    const [DefImages, setDefImages] = useState([]);// Comment translated to English.
    const [ShowImagesIndex, setShowImagesIndex] = useState(0);// Comment translated to English.
    const [hoverPreviewImg, setHoverPreviewImg] = useState(null);
    const [hoverPreviewKey, setHoverPreviewKey] = useState('');

    const [dialogPositions, setDialogPositions] = useState({});
    const dialogRefs = useRef({});
    const draggingDialogIdRef = useRef('');
    const dragOffsetRef = useRef({ x: 0, y: 0 });

    const handleDialogMouseMove = useCallback((e) => {
        const dialogId = draggingDialogIdRef.current;
        if (!dialogId) return;
        const dialog = dialogRefs.current[dialogId];
        if (!dialog) return;

        const rect = dialog.getBoundingClientRect();
        const canvasBody = document.querySelector('.canvasBody');
        const boundaryRect = canvasBody ? canvasBody.getBoundingClientRect() : {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            width: window.innerWidth,
            height: window.innerHeight
        };
        const dialogWidth = Math.min(rect.width, boundaryRect.width || rect.width);
        const dialogHeight = Math.min(rect.height, boundaryRect.height || rect.height);
        const minLeft = boundaryRect.left;
        const maxLeft = Math.max(minLeft, boundaryRect.right - dialogWidth);
        const minTop = boundaryRect.top;
        const maxTop = Math.max(minTop, boundaryRect.bottom - dialogHeight);
        const nextLeft = Math.min(Math.max(e.clientX - dragOffsetRef.current.x, minLeft), maxLeft);
        const nextTop = Math.min(Math.max(e.clientY - dragOffsetRef.current.y, minTop), maxTop);

        setDialogPositions((prev) => ({
            ...prev,
            [dialogId]: { left: nextLeft, top: nextTop }
        }));
    }, []);

    const handleDialogMouseUp = useCallback(() => {
        draggingDialogIdRef.current = '';
        window.removeEventListener('mousemove', handleDialogMouseMove);
        window.removeEventListener('mouseup', handleDialogMouseUp);
    }, [handleDialogMouseMove]);

    const handleDialogMouseDown = useCallback((dialogId, e) => {
        if (e.button !== 0) return;
        const dialog = dialogRefs.current[dialogId];
        if (!dialog) return;

        const rect = dialog.getBoundingClientRect();
        draggingDialogIdRef.current = dialogId;
        dragOffsetRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };

        window.addEventListener('mousemove', handleDialogMouseMove);
        window.addEventListener('mouseup', handleDialogMouseUp);
    }, [handleDialogMouseMove, handleDialogMouseUp]);

    const getDialogStyle = useCallback((dialogId, visible) => {
        if (!visible) return { display: 'none' };
        const position = dialogPositions[dialogId];
        if (!position) return { display: 'block' };
        return {
            display: 'block',
            left: position.left,
            top: position.top,
            transform: 'none'
        };
    }, [dialogPositions]);

    useEffect(() => {
        return () => {
            window.removeEventListener('mousemove', handleDialogMouseMove);
            window.removeEventListener('mouseup', handleDialogMouseUp);
        };
    }, [handleDialogMouseMove, handleDialogMouseUp]);

    const [dataSelect, setdataSelect] = useState({
        all: [],
        datadata: [],
        statedata: [],
        alarmdata: []
    });// Comment translated to English.

    const normalizeValue = (v) => (v === undefined || v === null ? '' : String(v).trim());

    const getDataKeyFirst = () => {
        if (!shapeAttr.attrs.dataKey || shapeAttr.attrs.dataKey.length === 0) return null;
        return shapeAttr.attrs.dataKey[0] || null;
    };

    const resolveCommandCategory = (typeRaw) => {
        const typeText = normalizeValue(typeRaw).toUpperCase();
        const prefix = typeText.charAt(0);

        // Rule requested by user: A=analog(data), B=state, C=alarm.
        if (prefix === 'A') return 'datadata';
        if (prefix === 'B') return 'statedata';
        if (prefix === 'C') return 'alarmdata';
        return '';
    };

    const buildParaDataSelect = (rows = []) => {
        const placeholder = { data: t('auto.k0512') };
        const all = [];
        const datadata = [];
        const statedata = [];
        const alarmdata = [];

        const seenAll = new Set();
        const seenData = new Set();
        const seenState = new Set();
        const seenAlarm = new Set();

        const pushUnique = (arr, seen, text) => {
            if (!text || seen.has(text)) return;
            seen.add(text);
            arr.push({ data: text });
        };

        rows.forEach((row) => {
            const desc = normalizeValue(
                row && (row.CommandDesc || row.commandDesc || row.CommandName || row.commandName || row.Desc || row.desc)
            );
            if (!desc) return;

            pushUnique(all, seenAll, desc);
            const cmdType = row && (row.CommandType || row.commandType || row.CmdType || row.cmdType || row.Type || row.type);
            const category = resolveCommandCategory(cmdType, desc);

            if (category === 'datadata') pushUnique(datadata, seenData, desc);
            if (category === 'statedata') pushUnique(statedata, seenState, desc);
            if (category === 'alarmdata') pushUnique(alarmdata, seenAlarm, desc);
        });

        return {
            all: [placeholder].concat(all),
            // Keep category lists strict, do not fallback to all.
            datadata: [placeholder].concat(datadata),
            statedata: [placeholder].concat(statedata),
            alarmdata: [placeholder].concat(alarmdata)
        };
    };

    const getDataSelectOptionsByAttrCode = (attrCode) => {
        if (attrCode === 'datadata') return dataSelect.datadata || [];
        if (attrCode === 'statedata') return dataSelect.statedata || [];
        if (attrCode === 'alarmdata') return dataSelect.alarmdata || [];
        return dataSelect.all || [];
    };

    const [clickType, setclickType] = useState(newclicktype);// Comment translated to English.
    const [eleLink, seteleLink] = useState((dragShape.clickEvnt && dragShape.clickEvnt.length > 0 && dragShape.clickEvnt[0].hasOwnProperty('link')) ? dragShape.clickEvnt[0]['link'] : null);// Comment translated to English.
    const [neweleLink, setneweleLink] = useState((dragShape.clickEvnt && dragShape.clickEvnt.length > 0 && dragShape.clickEvnt[0].hasOwnProperty('newlink')) ? dragShape.clickEvnt[0]['newlink'] : null);// Comment translated to English.
    const [savePagePidSel, setsavePagePidSel] = useState();// Comment translated to English.
    const [savePagePid, setsavePagePid] = useState((dragShape.clickEvnt && dragShape.clickEvnt.length > 0 && dragShape.clickEvnt[0].hasOwnProperty('weblink')) ? dragShape.clickEvnt[0]['weblink'] : null);// Comment translated to English.
    const [savePagePname, setsavePagePname] = useState();// Comment translated to English.
    const [videoChannel, setvideoChannel] = useState((dragShape.clickEvnt && dragShape.clickEvnt.length > 0 && dragShape.clickEvnt[0].hasOwnProperty('videoChannel')) ? dragShape.clickEvnt[0]['videoChannel'] : null);// Comment translated to English.

    // Comment translated to English.

    const paraClassName = shapeAttr.children && shapeAttr.children[0] ? shapeAttr.children[0].className : '';
    const dataKeyFirst = getDataKeyFirst();
    const paraDevKey = dataKeyFirst ? (dataKeyFirst.key || dataKeyFirst.devkey || '') : '';

    useEffect(() => {// Comment translated to English.
        async function getdataSelect() {
            if (paraClassName !== 'paraHtml' || !paraDevKey) {
                setdataSelect(buildParaDataSelect([]));
                return;
            }
            let res = await httpsend.getData('GetDeviceCommandListKey', {
                DevID: paraDevKey,
                ComboBox: '1'
            });
            if (res && Array.isArray(res.data)) {
                setdataSelect(buildParaDataSelect(res.data));
            } else {
                setdataSelect(buildParaDataSelect([]));
            }
        }
        getdataSelect();
    }, [paraClassName, paraDevKey]);

    // Comment translated to English.
    useEffect(() => {
        if (showImgBox === 1 || showGifImgBox === 1) {
            getImgData('system');
            getImgData('upload');
        }
    }, [showImgBox, showGifImgBox]);

    // Comment translated to English.
    useEffect(() => {
        if (showEventsBox === 1) {
            geteventData();
        } else {
            getevData();
        }
    }, [showEventsBox]);

    const geteventData = async () => {
        let res = await httpsend.getData('GetEventListKey', {
            ComboBox: "all"
        });
        if (res) {
            let eventsArr = [];
            res.data.forEach((val, n) => {
                eventsArr.push({
                    'label': val.DeviceName + '/' + val.AlarmName,
                    'value': val.DeviceName + '&' + val.id + '/' + val.AlarmName + '~' + val.DevId + '%' + (val.OnlyCode ? val.ServerIP + '@' + val.OnlyCode : '')// Comment translated to English.
                });
            })
            seteventsList(eventsArr);
        }
    }

    // Comment translated to English.
    const getImgData = async (type) => {
        let res = await httpsend.getDataLocal('imgData', { action: type });
        let imgData = [];
        if (res) {
            res.data.forEach(element => {
                let imgOne = { "img": element.imgUrl, "isani": element.imgUrl.endsWith('.gif') }
                imgData.push(imgOne);
            });
        }
        if (type === 'upload') setMyImages(imgData);
        if (type === 'system') setDefImages(imgData);
    }
    // Comment translated to English.
    const getParamData = async () => {
        let res = await httpsend.getData('GetParamListKey', {
            ComboBox: "all"
        });
        let parData = [];
        let parsData = [];
        if (res) {
            res.data.forEach(element => {
                parData.push({
                    'label': element.ParamName,
                    'value': element.id
                });
                parsData.push({
                    'label': element.ParamName,
                    'value': element.id + '&' + element.ParamName,
                });
            });
        }
        setcusparamList(parData);
        setcusparamsList(parsData);
    }
    // Comment translated to English.
    const getevData = async () => {
        let res = await httpsend.getData('GetDeviceListKey', {
            ComboBox: "all"
        });
        let devList = [];
        if (res) {
            let paramsArr = [];
            let commandArr = [];
            res.data.forEach((val, n) => {
                devList.push({
                    value: val.id + '&' + val.LinkMode + '/' + (val.OnlyCode ? val.ServerIP + '@' + val.OnlyCode : '1'),// Comment translated to English.
                    label: val.DeviceName,
                    param: val.DeviceLastDataArr
                })
                if (val.CommandData.length !== 0) {
                    for (var kes in val.CommandData) {
                        commandArr.push({
                            value: val.id + '/' + val.CommandData[kes].value + '/' + val.DeviceName + '/' + val.CommandData[kes].label + '/' + (val.OnlyCode ? val.ServerIP + '@' + val.OnlyCode : '1'),// Comment translated to English.
                            label: val.DeviceName + '/' + val.CommandData[kes].label
                        })
                    }
                }

                // Comment translated to English.
                if (!val.DeviceLastData) return true;
                // let LastReceiveData = val.DeviceLastData.replace(/'/g, '"');
                if (val.DeviceLastDataArr.length > 0) {
                    val.DeviceLastDataArr.forEach((item) => {
                        dealParamArr(val, item.data, paramsArr, item.cmdType);
                    })
                } else {
                    dealParamArr(val, val.DeviceLastData, paramsArr);
                }

                // Comment translated to English.
                if (paramDevId && String(val.id) === String(paramDevId).split('&')[0]) {
                    let paramArr = [];
                    val.DeviceLastDataArr.forEach((item) => {
                        let LastReceiveData = item.data.replace(/'/g, '"');
                        var jsonarr2 = JSON.parse(LastReceiveData);
                        for (var keys in jsonarr2) {
                            paramArr.push({
                                'label': keys,
                                'value': keys + '~' + val.LinkMode + '%' + item.cmdType + '|' + (val.OnlyCode ? val.ServerIP + '@' + val.OnlyCode : '1'),// Comment translated to English.
                            });
                        }
                        setparamList(paramArr);
                    })

                }
            })
            setdevList(devList);
            setcommandList(commandArr);
        }
    }
    // Comment translated to English.
    const dealParamArr = (val, revData, paramsArr, revDataType = '') => {
        let LastReceiveData = revData.replace(/'/g, '"');
        var jsonarr = [];
        try {
            jsonarr = JSON.parse(LastReceiveData);
        } catch (e) {
            if (e instanceof SyntaxError) {
                console.log(t('auto.k0515') + val.id + t('auto.k0516') + LastReceiveData);
            }
            return true;
        }
        for (var key in jsonarr) {
            paramsArr.push({
                'label': val.DeviceName + '/' + key,
                'value': val.id + '&' + val.DeviceName + '/' + key + '~' + val.LinkMode + '%' + revDataType + '|' + (val.OnlyCode ? val.ServerIP + '@' + val.OnlyCode : '1')// Comment translated to English.
            });
        }

        setparamsList(paramsArr);

    }
    // Comment translated to English.
    const getPageListData = async () => {
        let res = await httpsend.getData('GetDmpageListKey', { ComboBox: '1' });
        let options = [];
        let pname = '';
        if (res) {
            res.data.forEach((el) => {
                // Comment translated to English.
                if (savePagePid === el.id) pname = el.PageName;
                let firstop = {
                    value: el.id + '-' + el.PageName,
                    label: el.PageName
                }
                if (el.children.length !== 0) {
                    el.children.forEach((y) => {
                        if (savePagePid === y.id) pname = y.PageName;
                        let secop = {
                            value: y.id + '-' + y.PageName,
                            label: y.PageName
                        }
                        if (y.children.length !== 0) {
                            y.children.forEach((m) => {
                                if (savePagePid === m.id) pname = m.PageName;
                                let throp = {
                                    value: m.id + '-' + m.PageName,
                                    label: m.PageName
                                }
                                options.push(throp);
                            })
                        }
                        options.push(secop);
                    })
                }
                options.push(firstop);
            })
        }
        setsavePagePidSel(options);
        setsavePagePname(pname);
        setpagesList(options);
    }

    // Comment translated to English.
    const getVideoListData = async () => {
        let videoList = [];
        // Comment translated to English.
        let resLogin = await httpsend.getDataVideo('api/user/login?username=admin&password=551c76780e34e1c1fab9ff85dfc79947', {});
        if (resLogin) {
            // Comment translated to English.
            let resDev = await httpsend.getDataVideo('api/device/query/devices?page=1&count=100', {});
            if (resDev) {
                if (resDev.data.list.length !== 0) {
                    resDev.data.list.forEach(async (n) => {
                        // Comment translated to English.
                        let channelurl = 'api/device/query/tree/' + n.deviceId + '?page=1&count=100&parentId=' + n.deviceId + '&onlyCatalog=false';
                        let resChannel = await httpsend.getDataVideo(channelurl, {});
                        if (resChannel) {
                            if (resChannel.data.list.length !== 0) {
                                resChannel.data.list.forEach(async (y) => {
                                    videoList.push({
                                        label: n.name + '[' + y.name + ']',
                                        value: n.deviceId + '_' + y.id
                                    })
                                });
                                setvideoList(videoList);
                            } else {
                                setvideoList([]);
                            }
                        } else {
                            setvideoList([]);
                        }
                    });
                } else {
                    setvideoList([]);
                }
            } else {
                setvideoList([]);
            }
        }
    }
    useEffect(() => {
        const hasOpenLayer = showDevBox === 1 || showParamBox === 1 || showParamsBox === 1 || showClickBox === 1 || showPagesBox === 1 || showEventsBox === 1;
        if (hasOpenLayer) {
            getevData();
            if (showParamBox === 1 || showParamsBox === 1) getParamData();
            if (showClickBox === 1 || showPagesBox === 1) getPageListData();
            if (showClickBox === 1) getVideoListData();
        } else {
            setdevList([]);// Comment translated to English.
            setparamsList([]);
            setcommandList([]);
            setpagesList([]);// Comment translated to English.
            setvideoList([]);// Comment translated to English.
            setcusparamList([]);
            setsavePagePidSel([]);
            setcusparamsList([]);
        }
    }, [showDevBox, showParamBox, showParamsBox, showClickBox, showPagesBox, showEventsBox]);

    // Comment translated to English.
    const initFormData = shapeAttr.attrs.where;
    const reducer = (state, action) => {
        switch (action.type) {
            case 'patch': // Comment translated to English.
                let did = action.formData.id;
                let name = action.formData.name;
                state.forEach(item => {
                    if (item.id === did) {
                        item[name] = action.formData.val
                    }
                })
                shapeAttr.attrs.where = state;
                props.onChange({
                    ...dragShape
                })
                return state
            default:
                throw new Error()
        }
    }
    const [formData, dispatch] = useReducer(reducer, initFormData)

    // Comment translated to English.
    const handleValChange = debounce((e) => {
        // Comment translated to English.
        // Comment translated to English.
        const findAttr = shapeAttr.children.filter((v) => v.attrs.name === e.target.dataset.attrwhere);
        // Comment translated to English.
        if (e.target.dataset.attrcode === 'rowNum' || e.target.dataset.attrcode === 'colNum' || e.target.dataset.attrcode === 'cellWidth' || e.target.dataset.attrcode === 'cellHeight') {
            // Comment translated to English.
            if (e.target.dataset.attrcode === 'rowNum') findAttr[0].attrs['rowNum'] = e.target.value;
            if (e.target.dataset.attrcode === 'colNum') findAttr[0].attrs['colNum'] = e.target.value;
            if (e.target.dataset.attrcode === 'cellWidth') findAttr[0].attrs['cellWidth'] = e.target.value;
            if (e.target.dataset.attrcode === 'cellHeight') findAttr[0].attrs['cellHeight'] = e.target.value;
            // Comment translated to English.
            let wtoatl = findAttr[0].attrs['colNum'] * findAttr[0].attrs['cellWidth'];
            let htoatl = findAttr[0].attrs['rowNum'] * findAttr[0].attrs['cellHeight'];
            let wpath = [];
            let hpath = [];
            for (let w = 0; w <= findAttr[0].attrs['rowNum']; w++) {
                let val1 = '0,' + w * findAttr[0].attrs['cellHeight'];
                let val2 = wtoatl + ',' + w * findAttr[0].attrs['cellHeight'];
                if (w % 2 === 0) {
                    wpath.push(val1 + ',' + val2)
                } else {
                    wpath.push(val2 + ',' + val1)
                }
            }
            for (let h = 0; h <= findAttr[0].attrs['colNum']; h++) {
                let val1 = h * findAttr[0].attrs['cellWidth'] + ',0';
                let val2 = h * findAttr[0].attrs['cellWidth'] + ',' + htoatl;
                if (h % 2 === 0) {
                    hpath.push(val1 + ',' + val2)
                } else {
                    hpath.push(val2 + ',' + val1)
                }
            }
            findAttr[0]['attrs']['points'] = wpath.toString().split(',');
            findAttr[1]['attrs']['points'] = hpath.toString().split(',');
            // Comment translated to English.
            shapeAttr.children[0]['attrs']['width'] = wtoatl;
            shapeAttr.children[0]['attrs']['height'] = htoatl;
            shapeAttr.children[3]['attrs']['width'] = wtoatl;
            shapeAttr.children[3]['attrs']['height'] = htoatl;
        } else {
            findAttr.forEach(element => {
                // if (e.target.value) {
                const isNumberLike = e.target.dataset.attrtype === 'number' || e.target.dataset.attrtype === 'sortTopN';
                element['attrs'][e.target.dataset.attrcode] = isNumberLike ? parseFloat(e.target.value) : e.target.value;
                if (e.target.dataset.attrwhere === 'buttonRect') {// Comment translated to English.
                    if (e.target.dataset.attrcode === 'width' || e.target.dataset.attrcode === 'height') {
                        shapeAttr.children[1]['attrs'][e.target.dataset.attrcode] = element['attrs'][e.target.dataset.attrcode];
                    }
                }
                // Comment translated to English.
                //     shapeAttr.children[0]['attrs']['width'] = shapeAttr.children[0]['attrs']['width'] + shapeAttr.children[0]['attrs']['strokeWidth'] - 1;
                //     shapeAttr.children[0]['attrs']['height'] = shapeAttr.children[0]['attrs']['height'] + shapeAttr.children[0]['attrs']['strokeWidth'] - 1;
                // }
                // }
            });
        }
        props.onChange({
            ...dragShape
        })
    }, 100)
    // Comment translated to English.
    // Comment translated to English.
    const ondataDevOptionChange = (value) => {
        setparamList([]);
        setparam(null);
        setparamDevId(value);
        if (devList.length > 0) {
            devList.forEach(val => {
                if (val.value === value) {
                    // let LastReceiveData = v.param.replace(/'/g, '"');
                    // if (!LastReceiveData) return true;
                    // let paramArr = [];
                    // var jsonarr = [];
                    // try {
                    //     jsonarr = JSON.parse(LastReceiveData);
                    //     for (var key in jsonarr) {
                    //         paramArr.push({
                    //             'label': key,
                    //             'value': key
                    //         });
                    //     }
                    // } catch (e) {
                    //     if (e instanceof SyntaxError) {
                    // Comment translated to English.
                    //     }
                    // }
                    // setparamList(paramArr);
                    if (!val.param) return true;
                    let paramArr = [];
                    val.param.forEach((item) => {
                        try {
                            let LastReceiveData = item.data.replace(/'/g, '"');
                            let jsonarr = JSON.parse(LastReceiveData);
                            for (var keys in jsonarr) {
                                paramArr.push({
                                    'label': keys,
                                    'value': keys + '~' + value.split('&')[1].split('/')[0] + '%' + item.cmdType + '|' + value.split('/')[1],
                                });
                            }
                        } catch (e) {
                            if (e instanceof SyntaxError) {
                                console.log(t('auto.k0515') + value.split('&')[0] + t('auto.k0516') + item.data);
                            }
                        }
                        setparamList(paramArr);
                    })
                }
            })
        }
    };
    const ondataDevOptionSearch = (value) => { };
    // Comment translated to English.
    const onCommandOptionChange = (value) => { setcommand(value) };
    const onCommandOptionSearch = (value) => { };
    // Comment translated to English.
    const onParamOptionChange = (value) => { setparam(value) };
    const onParamOptionSearch = (value) => { };
    // Comment translated to English.
    const onCusParamOptionChange = (value) => { setcusparam(value) };
    const onCusParamOptionSearch = (value) => { };
    // Comment translated to English.
    const onParamsOptionChange = (value) => { setparams(value) };
    const onParamsOptionSearch = (value) => { };
    // Comment translated to English.
    const onCusParamsOptionChange = (value) => { setcusparams(value) };
    const onCusParamsOptionSearch = (value) => { };
    // Comment translated to English.
    const onPagesOptionChange = (value) => { setpages(value) };
    const onPagesOptionSearch = (value) => { };
    // Comment translated to English.
    const onDevEventsOptionChange = (value) => { setdevevents(value) };
    const onDevEventsOptionSearch = (value) => { };
    // Comment translated to English.
    const onEventsOptionChange = (value) => { setevents(value) };
    const onEventsOptionSearch = (value) => { };
    // Comment translated to English.
    const onLinkOptionChange = (value) => {
        setsavePagePid(value.split('-')[0]);
        setsavePagePname(value.split('-')[1])
    };
    const onlinkOptionSearch = (value) => { };
    // Comment translated to English.
    const ondataVideoOptionChange = (value) => { setvideoChannel(value) };
    const ondataVideoOptionSearch = (value) => { };
    // Comment translated to English.
    const filterOption = (input, option) => (option && option.label).toLowerCase().includes(input.toLowerCase());
    // Comment translated to English.
    const onClickOptionChange = (value) => {
        setclickType(value);
    };

    // Comment translated to English.
    const [handleImgWhere, sethandleImgWhere] = useState('myImage');
    // Comment translated to English.
    const [handleImgCode, sethandleImgCode] = useState('image');
    // Comment translated to English.
    function setimgChange(img, e) {
        if (handleImgCode === 'alarmImage') {
            setimgalarmUrl(img);
        } else {
            setimgUrl(img);
        }
        // console.log(handleImgWhere);
        // console.log(handleImgCode);
        const findAttr = dragShape.moduleJson.children.find((v) => v.attrs.name === handleImgWhere);
        if (findAttr) {// Comment translated to English.
            findAttr['attrs'][handleImgCode] = img;
            props.onChange({
                ...dragShape
            })
        } else {// Comment translated to English.
            dispatch({ type: "patch", formData: { val: img, name: "statusSelectColor", id: imgUrlId } })
        }
    }
    // Comment translated to English.
    if (shapeAttr.attrs.moduleAttr) {
        shapeAttr.attrs.moduleAttr.forEach((ats, y) => {
            let tleunikey = shapeId + '-' + y;// Comment translated to English.
            attrList.push(<div className="attrTitle" key={tleunikey}>{ats.attrGroupName}</div>)
            ats.attrGroupContent.forEach((a, z) => {
                const val = shapeAttr.children.find((v) => v.attrs.name === a.attrWhere);
                let unikey = shapeId + '-' + y + '-' + z;
                if (a.attrType === 'textarea') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <textarea
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}
                        ></textarea>
                    </div>)
                }
                if (a.attrType === 'selectFamily') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            {/* {FontSelect && FontSelect.map((fontone,n) => {
                                return <option value={fontone.name} key={n}>{fontone.name}</option>
                            })} */}
                            <option value={t('auto.k0011')}>{t('auto.k0011')}</option>
                            <option value={t('auto.k0231')}>{t('auto.k0231')}</option>
                            <option value={t('auto.k0232')}>{t('auto.k0232')}</option>
                            <option value={t('auto.k0233')}>{t('auto.k0233')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'aniSelect') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            {/* {FontSelect && FontSelect.map((fontone,n) => {
                                return <option value={fontone.name} key={n}>{fontone.name}</option>
                            })} */}
                            <option value='slide'>{t('auto.k0430')}</option>
                            <option value='fade'>{t('auto.k0431')}</option>
                            <option value='cube'>{t('auto.k0432')}</option>
                            <option value='coverflow'>{t('auto.k0433')}</option>
                            <option value='flip'>{t('auto.k0434')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'selectDataType') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='hour'>{t('auto.k0435')}</option>
                            <option value='day'>{t('auto.k0436')}</option>
                            <option value='month'>{t('auto.k0437')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'select') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='normal'>{t('auto.k0438')}</option>
                            <option value='bold'>{t('auto.k0439')}</option>
                            <option value='italic normal'>{t('auto.k0440')}</option>
                            <option value='italic bold'>{t('auto.k0613')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'selectAlign') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='center'>{t('auto.k0614')}</option>
                            <option value='left'>{t('auto.k0615')}</option>
                            <option value='right'>{t('auto.k0616')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'selectverticalAlign') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='middle'>{t('auto.k0617')}</option>
                            <option value='top'>{t('auto.k0618')}</option>
                            <option value='bottom'>{t('auto.k0619')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'number') {
                    if (a.attrCode === 'width' || a.attrCode === 'height') {
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <div style={{ 'display': 'inline-block' }}>
                                <input style={{ 'width': 'calc(50% - 9px)', 'display': 'inline-block' }}
                                    type="number"
                                    step='0.1'
                                    defaultValue={val.attrs[a.attrCode]}
                                    onChange={handleValChange}
                                    data-attrcode={a.attrCode}
                                    data-attrtype={a.attrType}
                                    data-attrwhere={a.attrWhere} />
                                <span style={{ 'margin': '0 5px', 'display': 'inline-block' }}>*</span>
                                <input style={{ 'width': 'calc(50% - 9px)', 'display': 'inline-block' }} value={a.attrCode === 'width' ? parseFloat(scaleX).toFixed(2) : parseFloat(scaleY).toFixed(2)} disabled />
                                <div style={{ 'marginTop': '5px' }}>
                                    <span style={{ 'marginRight': '5px', 'display': 'inline-block' }}>=</span>
                                    <input style={{ 'width': 'calc(100% - 17px)', 'display': 'inline-block' }} value={a.attrCode === 'width' ? (val.attrs[a.attrCode] * parseFloat(scaleX).toFixed(2)).toFixed(2) : (val.attrs[a.attrCode] * parseFloat(scaleY).toFixed(2)).toFixed(2)} disabled />
                                </div>
                            </div>
                        </div>)
                    } else {
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <input
                                type="number"
                                step='0.1'
                                defaultValue={val.attrs[a.attrCode]}
                                onChange={handleValChange}
                                data-attrcode={a.attrCode}
                                data-attrtype={a.attrType}
                                data-attrwhere={a.attrWhere} />
                        </div>)
                    }
                }
                if (a.attrType === 'text') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <input
                            type="text"
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere} />
                    </div>)
                }
                if (a.attrType === 'color') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <input
                            type="color"
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}
                        />
                    </div>)
                }
                if (a.attrType === 'selectTime') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='1'>y/m/d h:m:s</option>
                            <option value='2'>y-m-d h:m:s</option>
                            <option value='3'>y/m/d</option>
                            <option value='4'>y-m-d</option>
                            <option value='5'>h:m:s</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'image') {
                    if (a.attrCode === 'alarmImage') {
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <img src={imgalarmUrl ? imgalarmUrl : val.attrs[a.attrCode]}
                                alt={a.attrName}
                                data-attrcode={a.attrCode}
                                data-attrtype={a.attrType}
                                data-attrwhere={a.attrWhere}
                                onClick={() => {
                                    setshowImgBox(1);
                                    sethandleImgWhere(a.attrWhere);
                                    sethandleImgCode(a.attrCode);
                                }}
                            />
                        </div>)
                    } else {
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <img src={imgUrl ? imgUrl : val.attrs[a.attrCode]}
                                alt={a.attrName}
                                data-attrcode={a.attrCode}
                                data-attrtype={a.attrType}
                                data-attrwhere={a.attrWhere}
                                onClick={() => {
                                    setshowImgBox(1);
                                    sethandleImgWhere(a.attrWhere);
                                    sethandleImgCode(a.attrCode);
                                }}
                            />
                        </div>)
                    }

                }
                if (a.attrType === 'hardwareInputNew') {
                    if (a.attrCode === 'dataDevKey') {// Comment translated to English.
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <textarea className="attrTextarea" autoComplete="off" id="defDevKey" placeholder="" readOnly="readonly" defaultValue={paramData}></textarea>
                            <button className="attrBtn" data-attrwhere={a.attrWhere} onClick={() => setshowDevBox(1)}>{t('auto.k0448')}</button>
                        </div>)
                    }
                    if (a.attrCode === 'dataKey') {// Comment translated to English.
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <textarea className="attrTextarea" autoComplete="off" id="defDataKey" placeholder="" readOnly="readonly" defaultValue={paramData}></textarea>
                            <button className="attrBtn" data-attrwhere={a.attrWhere} onClick={() => setshowParamBox(1)}>{t('auto.k0449')}</button>
                        </div>)
                    }
                    if (a.attrCode === 'dataParamsKey') {// Comment translated to English.
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <textarea className="attrTextarea" autoComplete="off" id="defDataParamsKey" placeholder="" readOnly="readonly" defaultValue={paramData}></textarea>
                            <button className="attrBtn" data-attrwhere={a.attrWhere} onClick={() => setshowParamsBox(1)}>{t('auto.k0450')}</button>
                        </div>)
                    }
                    if (a.attrCode === 'pageKey') {// Comment translated to English.
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <textarea className="attrTextarea" autoComplete="off" id="defPageKey" placeholder="" readOnly="readonly" defaultValue={paramData}></textarea>
                            <button className="attrBtn" data-attrwhere={a.attrWhere} onClick={() => setshowPagesBox(1)}>{t('auto.k0451')}</button>
                        </div>)
                    }
                    if (a.attrCode === 'eventKey') {// Comment translated to English.
                        attrList.push(<div className="attrBox" key={unikey}>
                            <label>{a.attrName}</label>
                            <textarea className="attrTextarea" autoComplete="off" id="defEventsKey" placeholder="" readOnly="readonly" defaultValue={paramData}></textarea>
                            <button className="attrBtn" data-attrwhere={a.attrWhere} onClick={() => setshowEventsBox(1)}>{t('auto.k0452')}</button>
                        </div>)
                    }
                    // Comment translated to English.
                    //     attrList.push(<div className="attrBox" key={unikey}>
                    //         <label>{a.attrName}</label>
                    // Comment translated to English.
                    //             setparamData(e.target.value);
                    //             shapeAttr.attrs.dataKey = e.target.value;
                    //             props.onChange({
                    //                 ...dragShape
                    //             }, true)
                    //         }}></textarea>
                    //     </div>)
                    // }
                }
                if (a.attrType === 'whereStatusTableNew') {
                    attrList.push(<table className="attrTable" key={unikey}>
                        <thead>
                            <tr>
                                <th colSpan="4">{t('auto.k0453')}</th>
                            </tr>
                            <tr>
                                <th>{t('auto.k0454')}</th>
                                <th>{t('auto.k0455')}</th>
                                <th>{t('auto.k0456')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {
                                formData.map((trone) => {
                                    let trunikey = unikey + trone.id;
                                    return (<tr key={trunikey}>
                                        <td><input type="text" name="conditionNum" style={{ width: '80%' }} defaultValue={trone.conditionNum} onChange={e => dispatch({ type: "patch", formData: { val: e.target.value, name: "conditionNum", id: trone.id } })} /></td>
                                        <td><input type="text" name="conditionText" style={{ width: '80%' }} defaultValue={trone.conditionText} onChange={e => dispatch({ type: "patch", formData: { val: e.target.value, name: "conditionText", id: trone.id } })} /></td>
                                        <td><input type="color" name="statusSelectColor" defaultValue={trone.statusSelectColor} onChange={e => dispatch({ type: "patch", formData: { val: e.target.value, name: "statusSelectColor", id: trone.id } })} /></td>
                                    </tr>)
                                })
                            }
                        </tbody>
                    </table>)
                }
                if (a.attrType === 'imagesStatusTableNew') {
                    attrList.push(<table className="attrTable" key={unikey}>
                        <thead>
                            <tr>
                                <th colSpan="4">{t('auto.k0457')}</th>
                            </tr>
                            <tr>
                                <th>{t('auto.k0454')}</th>
                                <th>{t('auto.k0458')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {
                                formData.map((trone) => {
                                    let trunikey = unikey + trone.id;
                                    return (<tr key={trunikey}>
                                        <td><input type="text" name="conditionNum" style={{ width: '80%' }} defaultValue={trone.conditionNum} onChange={e => dispatch({ type: "patch", formData: { val: e.target.value, name: "conditionNum", id: trone.id } })} /></td>
                                        <td><img src={trone.statusSelectColor} style={{ width: 32, height: 32 }}
                                            alt={a.conditionNum}
                                            onClick={() => { setshowImgBox(1); setimgUrlId(trone.id) }}
                                        /></td>
                                    </tr>)
                                })
                            }
                        </tbody>
                    </table>)
                }
                if (a.attrType === 'rotateTableNewNew') {
                    attrList.push(<table className="attrTable" key={unikey}>
                        <thead>
                            <tr>
                                <th colSpan="4">{t('auto.k0459')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {
                                formData.map((trone) => {
                                    let trunikey = unikey + trone.id;
                                    return (<tr key={trunikey}>
                                        <td>{t('auto.k0454')}</td>
                                        <td><input type="text" name="conditionNum" style={{ width: '90%' }} defaultValue={trone.conditionNum} onChange={e => dispatch({ type: "patch", formData: { val: e.target.value, name: "conditionNum", id: trone.id } })} /></td>
                                        <td><img src={trone.statusSelectColor} style={{ width: 32, height: 32 }}
                                            alt={a.conditionNum}
                                            onClick={() => { setshowGifImgBox(1); setimgUrlId(trone.id) }}
                                        /></td>
                                    </tr>)
                                })
                            }
                        </tbody>
                    </table>)
                }

                // Comment translated to English.
                if (a.attrType === 'showSelect') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='1'>{t('auto.k0460')}</option>
                            <option value='2'>{t('auto.k0461')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'sortOrderSelect') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='desc'>{t('auto.k2004')}</option>
                            <option value='asc'>{t('auto.k2005')}</option>
                        </select>
                    </div>)
                }
                // 排序柱状图：显示前 N 个柱体（0 = 显示全部）
                if (a.attrType === 'sortTopN') {
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="0=全部"
                            defaultValue={val.attrs[a.attrCode] == null ? 0 : val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere} />
                    </div>)
                }
                if (a.attrType === 'orientSelect') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='vertical'>{t('auto.k0462')}</option>
                            <option value='horizontal'>{t('auto.k0463')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'alginSelect') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='auto'>{t('auto.k0464')}</option>
                            <option value='left'>{t('auto.k0615')}</option>
                            <option value='right'>{t('auto.k0616')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'dataSelect') {// Comment translated to English.
                    const selectOptions = getDataSelectOptionsByAttrCode(a.attrCode);
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            {selectOptions && selectOptions.map((va, n) => {
                                if (val.attrs[a.attrCode] && va.data === val.attrs[a.attrCode]) {
                                    return <option value={va.data} selected key={n}>{va.data}</option>
                                } else {
                                    return <option value={va.data} key={n}>{va.data}</option>
                                }
                            })}
                        </select>
                    </div>)
                }
                if (a.attrType === 'showYesNoSelect') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='1'>{t('auto.k0465')}</option>
                            <option value='2'>{t('auto.k0466')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'ropeDirection') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='1'>{t('auto.k0467')}</option>
                            <option value='2'>{t('auto.k0468')}</option>
                        </select>
                    </div>)
                }
                if (a.attrType === 'dataShowPos') {// Comment translated to English.
                    attrList.push(<div className="attrBox" key={unikey}>
                        <label>{a.attrName}</label>
                        <select
                            defaultValue={val.attrs[a.attrCode]}
                            onChange={handleValChange}
                            data-attrcode={a.attrCode}
                            data-attrtype={a.attrType}
                            data-attrwhere={a.attrWhere}>
                            <option value='1'>{t('auto.k0469')}</option>
                            <option value='2'>{t('auto.k0470')}</option>
                            <option value='3'>{t('auto.k0471')}</option>
                            <option value='4'>{t('auto.k0472')}</option>
                        </select>
                    </div>)
                }
            })
        })
    }
    // Comment translated to English.
    attrList.push(<div className="attrTitle" key={shapeId + '0000'}>{t('auto.k0473')}</div>)
    attrList.push(
        <div className="attrBox" key={shapeId + '0001'}>
            <label>{t('auto.k0474')}</label>
            <textarea className="attrTextarea" autoComplete="off" id="defClickKey" placeholder="" readOnly="readonly" defaultValue={clickDesc} style={{ height: 75, width: 115 }}></textarea>
            <button className="attrBtn" onClick={() => setshowClickBox(1)}>{t('auto.k0475')}</button>
        </div>
    )
    attrList.push(
        <div className="attrBox" key={shapeId + '00010'}>
            <label>{t('auto.k0476')}</label>
            <select
                defaultValue={tipsVal}
                onChange={(e) => {
                    props.onChange({
                        ...dragShape,
                        tipsVal: e.target.value
                    })
                    // console.log(
                    //     {
                    //         ...dragShape,
                    //         tipsVal: e.target.value
                    //     }
                    // )
                    settipsVal(e.target.value);
                }}>
                <option value='1'>{t('auto.k0465')}</option>
                <option value='2'>{t('auto.k0466')}</option>
            </select>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0002'} id="chooseClick" ref={(node) => { dialogRefs.current.chooseClick = node; }} style={getDialogStyle('chooseClick', showClickBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseClick', e)}>{t('auto.k0477')}</div>
            <div className="layui-layer-content">
                <div className="attrBox">
                    <label>{t('auto.k0478')}</label>
                    <Select
                        defaultValue={clickType}
                        onChange={onClickOptionChange}
                        options={[
                            {
                                value: 'order',
                                label: t('auto.k0423'),
                            },
                            {
                                value: 'link',
                                label: t('auto.k0401')
                            },
                            {
                                value: 'weblink',
                                label: t('auto.k0424')
                            },
                            {
                                value: 'newlink',
                                label: t('auto.k0425')
                            },
                            {
                                value: 'videoChannel',
                                label: t('auto.k0426')
                            },
                            {
                                value: 'None',
                                label: t('auto.k0427')
                            },
                            // {
                            //     value: 'full',
                            // Comment translated to English.
                            // },
                            // {
                            //     value: 'exitfull',
                            // Comment translated to English.
                            // },
                        ]}
                    />
                </div >
                {clickType === 'order' && <div className="attrBox">
                    <label>{t('auto.k0479')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={command}
                        onChange={onCommandOptionChange}
                        onSearch={onCommandOptionSearch}
                        options={commandList}
                    />
                </div>}
                {clickType === 'videoChannel' && <div className="attrBox">
                    <label>{t('auto.k0480')}</label>
                    {/* Comment translated to English. */}
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={videoChannel}
                        onChange={ondataVideoOptionChange}
                        onSearch={ondataVideoOptionSearch}
                        options={videoList}
                    />
                </div>}
                {(clickType === 'link') &&
                    <div className="attrBox">
                        <label>{t('auto.k0481')}</label>
                        <textarea className="attrTextarea" onChange={(e) => seteleLink(e.target.value)} defaultValue={eleLink}></textarea>
                    </div>
                }
                {(clickType === 'newlink') &&
                    <div className="attrBox">
                        <label>{t('auto.k0481')}</label>
                        <textarea className="attrTextarea" onChange={(e) => setneweleLink(e.target.value)} defaultValue={neweleLink}></textarea>
                    </div>
                }
                {clickType === 'weblink' &&
                    <div className="attrBox" key='00325'>
                        <label>{t('auto.k0482')}</label>
                        <Select
                            value={savePagePname}
                            showSearch
                            placeholder={t('auto.k0513')}
                            optionFilterProp="children"
                            onChange={onLinkOptionChange}
                            onSearch={onlinkOptionSearch}
                            filterOption={filterOption}
                            options={savePagePidSel}
                        />
                    </div>
                }
            </div>
            <span className="layui-layer-setwin" onClick={() => setshowClickBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={() => {
                    let desc = [];
                    if (clickType === 'order') {
                        command.forEach(element => {
                            desc.push({
                                devkey: element.split('/')[0],
                                command: element.split('/')[1],
                                devname: element.split('/')[2],
                                desc: element.split('/')[3],
                                src: element.split('/')[4]
                            })
                        });
                    }
                    if (clickType === 'link') {
                        desc.push({
                            link: eleLink
                        })
                    }
                    if (clickType === 'weblink') {
                        desc.push({
                            weblink: savePagePid
                        })
                    }
                    if (clickType === 'newlink') {
                        desc.push({
                            newlink: neweleLink
                        })
                    }
                    if (clickType === 'videoChannel') {
                        videoChannel.forEach(element => {
                            desc.push({
                                videoChannel: element
                            })
                        })
                    }
                    // if (clickType === 'full') {
                    //     desc.push({
                    //         full: true
                    //     })
                    // }
                    // if (clickType === 'exitfull') {
                    //     desc.push({
                    //         exitfull: true
                    //     })
                    // }
                    if (clickType === 'None') {

                        props.onChange({
                            ...dragShape,
                            clickEvnt: ''
                        }, true)
                    } else {
                        props.onChange({
                            ...dragShape,
                            clickEvnt: desc
                        }, true)
                        setclickDesc(JSON.stringify(desc))
                    }
                    setshowClickBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(<div className="attrTitle" key={shapeId + '000'}>{t('auto.k0484')}</div>)
    attrList.push(<div className="attrBox" key={shapeId + '001'}>
        <label>{t('auto.k0485')}</label>
        <input type="number" defaultValue={x ? parseFloat(x).toFixed(2) : 0.00} onChange={(e) => {
            props.onChange({
                ...dragShape,
                x: parseFloat(e.target.value)
            })
        }} />
    </div>)
    attrList.push(<div className="attrBox" key={shapeId + '002'}>
        <label>{t('auto.k0486')}</label>
        <input type="number" defaultValue={y ? parseFloat(y).toFixed(2) : 0.00} onChange={(e) => {
            props.onChange({
                ...dragShape,
                y: parseFloat(e.target.value)
            })
        }} />
    </div>)
    attrList.push(<div className="attrBox" key={shapeId + '003'}>
        <label>{t('auto.k0487')}</label>
        <input defaultValue={scaleX ? parseFloat(scaleX).toFixed(2) : 1} onChange={(e) => {
            props.onChange({
                ...dragShape,
                scaleX: parseFloat(e.target.value)
            })
        }} />
    </div>)
    attrList.push(<div className="attrBox" key={shapeId + '004'}>
        <label>{t('auto.k0488')}</label>
        <input defaultValue={scaleY ? parseFloat(scaleY).toFixed(2) : 1} onChange={(e) => {
            props.onChange({
                ...dragShape,
                scaleY: parseFloat(e.target.value)
            })
        }} />
    </div>)
    attrList.push(<div className="attrBox" key={shapeId + '005'}>
        <label>{t('auto.k0489')}</label>
        <input defaultValue={rotation ? parseFloat(rotation).toFixed(2) : 0} onChange={(e) => {
            props.onChange({
                ...dragShape,
                rotation: parseFloat(e.target.value)
            })
        }} />
    </div>)
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0005'} id="chooseDev" ref={(node) => { dialogRefs.current.chooseDev = node; }} style={getDialogStyle('chooseDev', showDevBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseDev', e)}>{t('auto.k0490')}</div>
            <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0491')}</label>
                    <Select
                        showSearch
                        placeholder={t('auto.k0513')}
                        optionFilterProp="children"
                        value={paramDevId}
                        onChange={ondataDevOptionChange}
                        onSearch={ondataDevOptionSearch}
                        filterOption={filterOption}
                        options={devList}
                    />
                </div>
            </div>
            <span className="layui-layer-setwin" onClick={() => setshowDevBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    let desc = {
                        key: paramDevId.split('&')[0],
                        type: paramDevId.split('&')[1].split('/')[0],
                        src: paramDevId.split('&')[1].split('/')[1],
                    }
                    setparamData(JSON.stringify(desc));
                    shapeAttr.attrs.dataKey = [desc];
                    props.onChange({
                        ...dragShape
                    }, true)
                    setshowDevBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0003'} id="chooseParam" ref={(node) => { dialogRefs.current.chooseParam = node; }} style={getDialogStyle('chooseParam', showParamBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseParam', e)}>{t('auto.k0492')}</div>
            <ul className="layui-nav">
                {ShowParaIndex === 0 &&
                    <>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowParaIndex(0)}>{t('auto.k0493')}</li>
                        <li className="layui-nav-item" onClick={() => setShowParaIndex(1)}>{t('auto.k0494')}</li>
                    </>
                }
                {ShowParaIndex === 1 &&
                    <>
                        <li className="layui-nav-item" onClick={() => setShowParaIndex(0)}>{t('auto.k0493')}</li>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowParaIndex(1)}>{t('auto.k0495')}</li>
                    </>
                }
            </ul>
            {ShowParaIndex === 0 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0491')}</label>
                    <Select
                        showSearch
                        placeholder={t('auto.k0513')}
                        optionFilterProp="children"
                        value={paramDevId}
                        onChange={ondataDevOptionChange}
                        onSearch={ondataDevOptionSearch}
                        filterOption={filterOption}
                        options={devList}
                    />
                </div>
                <div>
                    <label>{t('auto.k0496')}</label>
                    <Select
                        showSearch
                        value={param}
                        placeholder={t('auto.k0513')}
                        optionFilterProp="children"
                        onChange={onParamOptionChange}
                        onSearch={onParamOptionSearch}
                        filterOption={filterOption}
                        options={paramList}
                    />
                </div>
            </div>
            }
            {ShowParaIndex === 1 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0497')}</label>
                    <Select
                        showSearch
                        value={cusparam}
                        placeholder={t('auto.k0513')}
                        optionFilterProp="children"
                        onChange={onCusParamOptionChange}
                        onSearch={onCusParamOptionSearch}
                        filterOption={filterOption}
                        options={cusparamList}
                    />
                </div>
            </div>
            }
            <span className="layui-layer-setwin" onClick={() => setshowParamBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    let desc;
                    if (ShowParaIndex === 0) {
                        desc = {
                            key: paramDevId.split('&')[0],
                            name: param.split('~')[0],
                            type: param.split('~')[1].split('%')[0],
                            cmdtype: param.split('~')[1].split('%')[1].split('|')[0],
                            src: param.split('|')[1]
                        }
                    } else {
                        desc = {
                            parkey: cusparam
                        }
                    }
                    setparamData(JSON.stringify(desc));
                    shapeAttr.attrs.dataKey = [desc];
                    props.onChange({
                        ...dragShape
                    }, true)
                    setshowParamBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0006'} id="chooseParams" ref={(node) => { dialogRefs.current.chooseParams = node; }} style={getDialogStyle('chooseParams', showParamsBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseParams', e)}>{t('auto.k0498')}</div>
            <ul className="layui-nav">
                {ShowParasIndex === 0 &&
                    <>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowParasIndex(0)}>{t('auto.k0499')}</li>
                        <li className="layui-nav-item" onClick={() => setShowParasIndex(1)}>{t('auto.k0500')}</li>
                    </>
                }
                {ShowParasIndex === 1 &&
                    <>
                        <li className="layui-nav-item" onClick={() => setShowParasIndex(0)}>{t('auto.k0499')}</li>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowParasIndex(1)}>{t('auto.k0501')}</li>
                    </>
                }
            </ul>
            {ShowParasIndex === 0 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0496')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={params}
                        onChange={onParamsOptionChange}
                        onSearch={onParamsOptionSearch}
                        options={paramsList}
                    />
                </div>
            </div>
            }
            {ShowParasIndex === 1 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0497')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={cusparams}
                        onChange={onCusParamsOptionChange}
                        onSearch={onCusParamsOptionSearch}
                        options={cusparamsList}
                    />
                </div>
            </div>
            }
            <span className="layui-layer-setwin" onClick={() => setshowParamsBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    let desc = [];
                    if (ShowParasIndex === 0) {
                        params.forEach(element => {
                            console.log(element)
                            // 安全解析：防止设备名/点位名中包含分隔符导致崩溃
                            try {
                                if (!element || typeof element !== 'string') return;

                                // 按最后一个 | 分割 src
                                const lastPipeIndex = element.lastIndexOf('|');
                                if (lastPipeIndex === -1) return;
                                const src = element.substring(lastPipeIndex + 1);
                                const beforeSrc = element.substring(0, lastPipeIndex);

                                // 按第一个 & 分割 devkey
                                const firstAmpIndex = beforeSrc.indexOf('&');
                                if (firstAmpIndex === -1) return;
                                const devkey = beforeSrc.substring(0, firstAmpIndex);
                                const afterDevkey = beforeSrc.substring(firstAmpIndex + 1);

                                // 按最后一个 ~ 分割 type 和 cmdtype（因为 name 可能包含 /）
                                const lastTildeIndex = afterDevkey.lastIndexOf('~');
                                if (lastTildeIndex === -1) return;
                                const beforeType = afterDevkey.substring(0, lastTildeIndex);
                                const afterType = afterDevkey.substring(lastTildeIndex + 1);

                                // 按第一个 / 分割 dev 和 name（假设 dev 不含 /，name 可能含 /）
                                const firstSlashIndex = beforeType.indexOf('/');
                                if (firstSlashIndex === -1) return;
                                const dev = beforeType.substring(0, firstSlashIndex);
                                const name = beforeType.substring(firstSlashIndex + 1);

                                // 按第一个 % 分割 type 和 cmdtype
                                const firstPercentIndex = afterType.indexOf('%');
                                if (firstPercentIndex === -1) return;
                                const type = afterType.substring(0, firstPercentIndex);
                                const cmdtype = afterType.substring(firstPercentIndex + 1);

                                desc.push({ devkey, dev, name, type, cmdtype, src });
                            } catch (err) {
                                console.error('解析参数失败:', element, err);
                            }
                        });
                    } else {
                        cusparams.forEach(element => {
                            // 安全解析：按第一个 & 分割，允许 name 包含 &
                            try {
                                if (!element || typeof element !== 'string') return;
                                const firstAmpIndex = element.indexOf('&');
                                if (firstAmpIndex === -1) return;
                                const paramskey = element.substring(0, firstAmpIndex);
                                const name = element.substring(firstAmpIndex + 1);
                                desc.push({ paramskey, name });
                            } catch (err) {
                                console.error('解析自定义参数失败:', element, err);
                            }
                        });
                    }

                    setparamData(JSON.stringify(desc));
                    shapeAttr.attrs.dataKey = desc;
                    props.onChange({
                        ...dragShape
                    }, true)
                    setshowParamsBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0008'} id="choosePage" ref={(node) => { dialogRefs.current.choosePage = node; }} style={getDialogStyle('choosePage', showPagesBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('choosePage', e)}>{t('auto.k0502')}</div>
            <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0503')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={pages}
                        onChange={onPagesOptionChange}
                        onSearch={onPagesOptionSearch}
                        options={pagesList}
                    />
                </div>
            </div>
            <span className="layui-layer-setwin" onClick={() => setshowPagesBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    let desc = [];
                    pages.forEach(element => {
                        // 安全解析：按第一个 - 分割，允许 name 包含 -
                        try {
                            if (!element || typeof element !== 'string') return;
                            const firstDashIndex = element.indexOf('-');
                            if (firstDashIndex === -1) return;
                            const pagekey = element.substring(0, firstDashIndex);
                            const name = element.substring(firstDashIndex + 1);
                            desc.push({ pagekey, name });
                        } catch (err) {
                            console.error('解析页面失败:', element, err);
                        }
                    });
                    setparamData(JSON.stringify(desc));
                    shapeAttr.attrs.dataKey = desc;
                    props.onChange({
                        ...dragShape
                    }, true)
                    setshowPagesBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0009'} id="chooseEvents" ref={(node) => { dialogRefs.current.chooseEvents = node; }} style={getDialogStyle('chooseEvents', showEventsBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseEvents', e)}>{t('auto.k0504')}</div>
            <ul className="layui-nav">
                {ShowEventIndex === 0 &&
                    <>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowEventIndex(0)}>{t('auto.k0505')}</li>
                        <li className="layui-nav-item" onClick={() => setShowEventIndex(1)}>{t('auto.k0506')}</li>
                    </>
                }
                {ShowEventIndex === 1 &&
                    <>
                        <li className="layui-nav-item" onClick={() => setShowEventIndex(0)}>{t('auto.k0505')}</li>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowEventIndex(1)}>{t('auto.k0506')}</li>
                    </>
                }
            </ul>
            {ShowEventIndex === 0 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0491')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={devevents}
                        onChange={onDevEventsOptionChange}
                        onSearch={onDevEventsOptionSearch}
                        options={devList}
                    />
                </div>
            </div>
            }
            {ShowEventIndex === 1 && <div className="layui-layer-content">
                <div>
                    <label>{t('auto.k0507')}</label>
                    <Select
                        mode="multiple"
                        style={{
                            width: '100%',
                        }}
                        placeholder={t('auto.k0512')}
                        defaultValue={events}
                        onChange={onEventsOptionChange}
                        onSearch={onEventsOptionSearch}
                        options={eventsList}
                    />
                </div>
            </div>
            }
            <span className="layui-layer-setwin" onClick={() => setshowEventsBox(0)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    let desc = [];
                    if (ShowEventIndex === 0) {
                        devevents.forEach(element => {
                            // 安全解析：deveventskey & type / src
                            try {
                                if (!element || typeof element !== 'string') return;
                                const firstAmpIndex = element.indexOf('&');
                                if (firstAmpIndex === -1) return;
                                const deveventskey = element.substring(0, firstAmpIndex);
                                const afterAmp = element.substring(firstAmpIndex + 1);

                                const firstSlashIndex = afterAmp.indexOf('/');
                                if (firstSlashIndex === -1) return;
                                const type = afterAmp.substring(0, firstSlashIndex);
                                const src = afterAmp.substring(firstSlashIndex + 1);

                                desc.push({ deveventskey, type, src });
                            } catch (err) {
                                console.error('解析设备事件失败:', element, err);
                            }
                        })
                    } else {
                        events.forEach(element => {
                            // 安全解析：eventsdevname & eventskey / name ~ eventsdevkey % src
                            // 格式：eventsdevname & eventskey / name ~ ? % eventsdevkey % src
                            try {
                                if (!element || typeof element !== 'string') return;

                                // 按最后一个 % 分割 src
                                const lastPercentIndex = element.lastIndexOf('%');
                                if (lastPercentIndex === -1) return;
                                const src = element.substring(lastPercentIndex + 1);
                                const beforeSrc = element.substring(0, lastPercentIndex);

                                // 按倒数第二个 % 分割 eventsdevkey
                                const secondLastPercentIndex = beforeSrc.lastIndexOf('%');
                                if (secondLastPercentIndex === -1) return;
                                const eventsdevkey = beforeSrc.substring(secondLastPercentIndex + 1);
                                const beforeEventsdevkey = beforeSrc.substring(0, secondLastPercentIndex);

                                // 按第一个 & 分割 eventsdevname
                                const firstAmpIndex = beforeEventsdevkey.indexOf('&');
                                if (firstAmpIndex === -1) return;
                                const eventsdevname = beforeEventsdevkey.substring(0, firstAmpIndex);
                                const afterAmp = beforeEventsdevkey.substring(firstAmpIndex + 1);

                                // 按第一个 / 分割 eventskey 和 name（允许 name 包含 /）
                                const firstSlashIndex = afterAmp.indexOf('/');
                                if (firstSlashIndex === -1) return;
                                const eventskey = afterAmp.substring(0, firstSlashIndex);
                                const nameWithTilde = afterAmp.substring(firstSlashIndex + 1);

                                // 按第一个 ~ 分割 name（允许 name 包含 ~）
                                const firstTildeIndex = nameWithTilde.indexOf('~');
                                const name = firstTildeIndex === -1 ? nameWithTilde : nameWithTilde.substring(0, firstTildeIndex);

                                desc.push({ eventsdevname, eventskey, name, eventsdevkey, src });
                            } catch (err) {
                                console.error('解析事件失败:', element, err);
                            }
                        });
                    }
                    // console.log(desc)
                    setparamData(JSON.stringify(desc));
                    shapeAttr.attrs.dataKey = desc;
                    props.onChange({
                        ...dragShape
                    }, true)
                    setshowEventsBox(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0004'} id="chooseImg" ref={(node) => { dialogRefs.current.chooseImg = node; }} style={getDialogStyle('chooseImg', showImgBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseImg', e)}>{t('auto.k0508')}</div>
            <ul className="layui-nav">
                {ShowImagesIndex === 0 &&
                    <>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowImagesIndex(0)}>{t('auto.k0509')}</li>
                        <li className="layui-nav-item" onClick={() => setShowImagesIndex(1)}>{t('auto.k0510')}</li>
                    </>
                }
                {ShowImagesIndex === 1 &&
                    <>
                        <li className="layui-nav-item" onClick={() => setShowImagesIndex(0)}>{t('auto.k0509')}</li>
                        <li className="layui-nav-item layui-nav-itemcheck" onClick={() => setShowImagesIndex(1)}>{t('auto.k0510')}</li>
                    </>
                }

            </ul>
            {ShowImagesIndex === 0 && <div className="layui-layer-content selImgBoxWrap" onMouseLeave={() => { setHoverPreviewImg(null); setHoverPreviewKey(''); }}>
                <div className="selImgBox">
                    {
                        MyImages.map((imgs, n) => {
                            let unikey = shapeId + '0004' + n;
                            return (<img
                                src={imgs.img}
                                key={unikey}
                                data-attrcode="image"
                                data-attrwhere="myImage"
                                onMouseEnter={() => { setHoverPreviewImg(imgs.img); setHoverPreviewKey(unikey); }}
                                onClick={(e) => setimgChange(imgs.img, e)}
                                alt={imgs.img}
                                style={hoverPreviewKey === unikey ? { border: '2px solid red' } : undefined}
                            />)
                        })
                    }
                </div>
                <div className="selImgPreview">
                    {hoverPreviewImg ? <img src={hoverPreviewImg} alt="preview" /> : <span>请选择左侧图片进行预览</span>}
                </div>
            </div>}
            {ShowImagesIndex === 1 && <div className="layui-layer-content selImgBoxWrap" onMouseLeave={() => setHoverPreviewImg(null)}>
                <div className="selImgBox">
                    {
                        DefImages.map((imgs, n) => {
                            let unikey = shapeId + '0004' + n;
                            return (<img
                                src={imgs.img}
                                key={unikey}
                                data-attrcode="image"
                                data-attrwhere="myImage"
                                onMouseEnter={() => setHoverPreviewImg(imgs.img)}
                                onClick={(e) => setimgChange(imgs.img, e)}
                                alt={imgs.img}
                            />)
                        })
                    }
                </div>
                <div className="selImgPreview">
                    {hoverPreviewImg ? <img src={hoverPreviewImg} alt="preview" /> : <span>请选择左侧图片进行预览</span>}
                </div>
            </div>}
            <span className="layui-layer-setwin" onClick={() => { setshowImgBox(0); setimgUrlId(0); }}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    setshowImgBox(0);
                    setimgUrlId(0);
                    sethandleImgWhere('');
                    sethandleImgCode('');
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key={shapeId + '0007'} id="chooseGifImg" ref={(node) => { dialogRefs.current.chooseGifImg = node; }} style={getDialogStyle('chooseGifImg', showGifImgBox === 1)}>
            <div className="layui-layer-title" onMouseDown={(e) => handleDialogMouseDown('chooseGifImg', e)}>{t('auto.k0511')}</div>
            <div className="layui-layer-content selImgBoxWrap" onMouseLeave={() => setHoverPreviewImg(null)}>
                <div className="selImgBox">
                    {
                        MyImages.map((imgs, n) => {
                            let unikey = shapeId + '0007' + n;
                            return (<img
                                src={imgs.img}
                                key={unikey}
                                data-attrcode="image"
                                data-attrwhere="myImage"
                                onMouseEnter={() => setHoverPreviewImg(imgs.img)}
                                onClick={(e) => dispatch({ type: "patch", formData: { val: imgs.img, name: "statusSelectColor", id: imgUrlId } })}
                                alt={imgs.img}
                            />)
                        })
                    }
                </div>
                <div className="selImgPreview">
                    {hoverPreviewImg ? <img src={hoverPreviewImg} alt="preview" /> : <span>图片预览</span>}
                </div>
            </div>
            <span className="layui-layer-setwin" onClick={() => { setshowGifImgBox(0); setimgUrlId(0); }}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    setshowGifImgBox(0);
                    setimgUrlId(0);
                }}>{t('auto.k0483')}</Button>
            </div>
        </div>
    )

    return attrList;
})
export default ElementAttr;

