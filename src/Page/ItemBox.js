import React, { useEffect, useState } from 'react';
import { nav } from './ItemNav';
import BasicComponents from './Data/BasicComponents';
import ScreenTemplate from './Data/ScreenTemplate';
import httpsend from '../Assets/httpsend';
import { localizeDeep, t } from '../i18n';
import { CloseCircleOutlined, FileExclamationOutlined, FileOutlined, FileProtectOutlined } from '@ant-design/icons';
import { Button, Cascader, message, Tree, Upload } from 'antd';
import { Close } from '@mui/icons-material';

function ItemBox(props) {
    const [selectedNav, setSelectedNav] = useState(0);
    const [selectedData, setSelectedData] = useState([]);
    const [pagedata, setpagedata] = useState([]);
    const [savePagePidSel, setsavePagePidSel] = useState();

    const [showDelbtn, setshowDelbtn] = useState(0);
    const [showTplDelbtn, setshowTplDelbtn] = useState(0);
    const [hoverPreviewImg, setHoverPreviewImg] = useState('');
    const [hoverPreviewPos, setHoverPreviewPos] = useState({ x: 0, y: 0 });

    const [editPageId, seteditPageId] = useState();
    const [editPageName, seteditPageName] = useState();
    const [editPagePidName, seteditPagePidName] = useState();
    const [editPageIndex, seteditPageIndex] = useState();
    const [editPageType, seteditPageType] = useState();
    const [editPagePid, seteditPagePid] = useState();
    const [editPageLink, seteditPageLink] = useState();
    const [editPageTop, seteditPageTop] = useState('-1');
    const [editPageTxt, seteditPageTxt] = useState();

    const [isdelModalOpen, setIsdelModalOpen] = useState(false);
    const [showeditPageBox, setshoweditPageBox] = useState(false);

    const normalizePageTxt = (val) => String(val || '')
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        .replace(/\.txt$/i, '')
        .trim();

    const duplicateMsgHints = ['已存在', 'already exists', 'duplicate', '重复'];
    const isDuplicateCreateError = (res) => {
        if (!res || res.code === 100) return false;
        const msg = String((res.msg || '')).toLowerCase();
        return duplicateMsgHints.some((hint) => msg.includes(hint.toLowerCase()));
    };

    const collectExistingPages = (items, collector) => {
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
            if (!item || typeof item !== 'object') return;
            collector(item);
            if (Array.isArray(item.children) && item.children.length > 0) {
                collectExistingPages(item.children, collector);
            }
        });
    };

    useEffect(() => {
        if (selectedNav === 0) getImgData('page');
    }, []);

    useEffect(() => {
        if (props.isChanged !== '0' && selectedNav === 0) getImgData('page');
    }, [props.isChanged]);

    useEffect(() => {
        if (showeditPageBox && editPageId) {
            setTimeout(async function () {
                let res = await httpsend.getData('GetDmpageListKey', { ComboBox: '1' });
                let options = [{
                    value: '0',
                    label: t('itemBox.topLevelPage')
                }];

                if (res) {
                    res.data.forEach((el) => {
                        let firstop = {
                            value: el.id,
                            label: el.PageName
                        };

                        if (el.children.length !== 0) {
                            firstop.children = [];
                            el.children.forEach((y) => {
                                let secop = {
                                    value: y.id,
                                    label: y.PageName
                                };
                                if (y.children.length !== 0) {
                                    secop.children = [];
                                    y.children.forEach((m) => {
                                        let throp = {
                                            value: m.id,
                                            label: m.PageName
                                        };
                                        secop.children.push(throp);
                                    });
                                }
                                firstop.children.push(secop);
                            });
                        }
                        options.push(firstop);
                    });
                }

                setsavePagePidSel(options);

                if (editPageId) {
                    let conres = await httpsend.getData('GetDmpageDetailKey', { id: editPageId });
                    if (conres) {
                        seteditPageName(conres.data.PageName);
                        seteditPageIndex(parseInt(conres.data.PageIndex));
                        seteditPageType(conres.data.PageType);
                        seteditPagePid(conres.data.pid);
                        if (conres.data.PageType === '3') {
                            seteditPageLink(conres.data.PageTxt);
                        }
                        seteditPageTop((conres.data.PageTop).toString());
                    }
                }
            });
        }
    }, [showeditPageBox, editPageId]);

    const changeSelectedNav = (id) => {
        setSelectedNav(id);
        const localizedBasicComponents = localizeDeep(BasicComponents);
        switch (id) {
            case 1:
                setSelectedData(localizedBasicComponents.filter((item) => item.moduleJson && item.moduleJson.children && item.moduleJson.children[0] && item.moduleJson.children[0].className !== 'Echart'));
                break;
            case 2:
                setSelectedData(localizedBasicComponents.filter((item) => item.moduleJson && item.moduleJson.children && item.moduleJson.children[0] && item.moduleJson.children[0].className === 'Echart'));
                break;
            case 3:
                setSelectedData(localizeDeep(ScreenTemplate));
                break;
            case 4:
                getImgData('tpl');
                break;
            case 5:
                getImgData('system');
                break;
            case 6:
                getImgData('upload');
                break;
            case 0:
                getImgData('page');
                break;
            default:
                break;
        }
    };

    const getImgData = async (type) => {
        let imgData = [];
        let pageDataLocal = [];

        if (type === 'page') {
            let res = await httpsend.getData('GetDmpageListKey', { ComboBox: 'all' });
            if (res) {
                res.data.forEach((element) => {
                    let zuP = element.PageType.toString() === '1' ? <FileProtectOutlined /> : (element.PageType.toString() === '2' ? <FileOutlined /> : <FileExclamationOutlined />);
                    let indexP = element.PageTop.toString() === '1' ? t('itemBox.homeTag') : '';
                    let pagei = element.PageIndex.length === 1 ? `00${element.PageIndex}` : (element.PageIndex.length === 2 ? `0${element.PageIndex}` : element.PageIndex.toString());

                    let dataone = {
                        ...element,
                        key: `${element.id}-${element.PageType}`,
                        title: `${indexP}[${pagei}]${element.PageName}`,
                        icon: zuP,
                        parantTree: '0',
                        children: [],
                        iconBase64: 'Images/icon/page.png',
                        moduleJson: 'page',
                    };

                    pageDataLocal.push(dataone);

                    if (element.children.length !== 0) {
                        element.children.forEach((ele) => {
                            let zuP1 = ele.PageType.toString() === '1' ? <FileProtectOutlined /> : (ele.PageType.toString() === '2' ? <FileOutlined /> : <FileExclamationOutlined />);
                            let indexP1 = ele.PageTop.toString() === '1' ? t('itemBox.homeTag') : '';
                            let pagei1 = ele.PageIndex.length === 1 ? `00${ele.PageIndex}` : (ele.PageIndex.length === 2 ? `0${ele.PageIndex}` : ele.PageIndex.toString());

                            let datasec = {
                                ...ele,
                                key: `${ele.id}-${ele.PageType}`,
                                title: `${indexP1}[${pagei1}]${ele.PageName}`,
                                icon: zuP1,
                                parantTree: element.id.toString(),
                                children: [],
                                iconBase64: 'Images/icon/page.png',
                                moduleJson: 'page'
                            };

                            pageDataLocal.push(datasec);

                            if (ele.children.length !== 0) {
                                ele.children.forEach((el) => {
                                    let zuP2 = el.PageType.toString() === '1' ? <FileProtectOutlined /> : (el.PageType.toString() === '2' ? <FileOutlined /> : <FileExclamationOutlined />);
                                    let indexP2 = el.PageTop.toString() === '1' ? t('itemBox.homeTag') : '';
                                    let pagei2 = el.PageIndex.length === 1 ? `00${el.PageIndex}` : (el.PageIndex.length === 2 ? `0${el.PageIndex}` : el.PageIndex.toString());

                                    let datathr = {
                                        ...el,
                                        key: `${el.id}-${el.PageType}`,
                                        title: `${indexP2}[${pagei2}]${el.PageName}`,
                                        icon: zuP2,
                                        parantTree: `${element.id}-${ele.id}`,
                                        children: [],
                                        iconBase64: 'Images/icon/page.png',
                                        moduleJson: 'page',
                                    };

                                    datasec.children.push(datathr);
                                    pageDataLocal.push(datathr);
                                });
                            }

                            dataone.children.push(datasec);
                        });
                    }

                    imgData.push(dataone);
                });
            }

            setSelectedData(imgData);
            setpagedata(pageDataLocal);
            return;
        }

        let res = await httpsend.getDataLocal('imgData', { action: type });
            if (res) {
                if (type === 'tpl') {
                    imgData = localizeDeep(res.data);
                } else {
                res.data.forEach((element) => {
                    let imgOne = {
                        moduleName: t('itemBox.image'),
                        iconBase64: element.imgUrl,
                        moduleJson: {
                            attrs: {
                                moduleAttr: [
                                    {
                                        attrGroupName: t('itemBox.appearance'),
                                        attrGroupContent: [
                                            {
                                                attrName: t('itemBox.imageWidth'),
                                                attrCode: 'width',
                                                attrType: 'number',
                                                attrWhere: 'myImage'
                                            },
                                            {
                                                attrName: t('itemBox.imageHeight'),
                                                attrCode: 'height',
                                                attrType: 'number',
                                                attrWhere: 'myImage'
                                            }
                                        ]
                                    }
                                ]
                            },
                            children: [
                                {
                                    attrs: {
                                        name: 'myImage',
                                        image: element.imgUrl,
                                        width: 50,
                                        height: 50
                                    },
                                    className: 'Image'
                                }
                            ],
                            width: 50,
                            height: 50
                        }
                    };
                    imgData.push(imgOne);
                });
            }
        }

        setSelectedData(imgData);
    };

    const toBase64DataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file read failed'));
        reader.readAsDataURL(file);
    });

    const uploadprops = {
        name: 'file',
        showUploadList: false,
        customRequest: async ({ file, onSuccess, onError }) => {
            try {
                const fileData = await toBase64DataUrl(file);
                const res = await httpsend.getDataLocal('upload', {
                    fileName: file.name,
                    fileData,
                });
                if (res && res.code === 100) {
                    onSuccess(res);
                    return;
                }
                onError(new Error((res && res.msg) || t('itemBox.uploadFailed')));
            } catch (error) {
                onError(error);
            }
        },
        beforeUpload: (file) => {
            const isImage = file.type === 'image/png' || file.type === 'image/jpg' || file.type === 'image/gif' || file.type === 'image/jpeg' || file.type === 'image/svg' || file.type === 'image/bmp';
            if (!isImage) {
                message.error(`${file.name} ${t('itemBox.notImageFile')}`);
            }
            const isLt20M = file.size / 1024 / 1024 < 20;
            if (!isLt20M) {
                message.error(t('itemBox.imageTooLarge'));
            }
            return isImage && isLt20M;
        },
        onChange(info) {
            if (info.file.status === 'done') {
                if (info.file.response && info.file.response.code === 100) {
                    message.success(t('itemBox.uploadSuccess'));
                    getImgData('upload');
                } else {
                    message.error(info.file.response.msg);
                }
            } else if (info.file.status === 'error') {
                message.error(`${info.file.name} ${t('itemBox.uploadFailed')}`);
            }
        },
    };

    const delThisImg = async (txt, type) => {
        let delinfo = {};
        if (type === 'img') {
            delinfo = { action: 'del', img: txt };
        }
        if (type === 'tpl') {
            const protectedTplNames = [
                'UPS',
                t('templates.batteryGroup'),
                t('templates.environmentMonitor'),
                t('templates.precisionAc'),
                t('templates.powerCabinetInlet'),
                t('templates.powerCabinetBranch'),
                t('templates.normalAc'),
                t('templates.microModule'),
            ];
            if (protectedTplNames.includes(txt)) {
                message.error(t('itemBox.defaultTemplateNotDeletable'));
                return false;
            }
            delinfo = { action: 'deltpl', name: txt };
        }

        let res = await httpsend.getDataLocal('imgData', delinfo);
        if (res) {
            message.success(t('itemBox.deleteSuccess'));
            if (type === 'img') getImgData('upload');
            if (type === 'tpl') getImgData('tpl');
        }
        return true;
    };

    const onTreeSelect = (val) => {
        if (val[0]) {
            if (pagedata.length !== 0) {
                let thisPage = pagedata.findIndex((v) => String(v.id) === String(val[0].split('-')[0]));
                if (thisPage > -1) {
                    seteditPageId(pagedata[thisPage].id);
                    seteditPageName(pagedata[thisPage].PageName);
                    seteditPagePidName(pagedata[thisPage].parantTree.indexOf('-') > -1 ? pagedata[thisPage].parantTree.split('-') : [pagedata[thisPage].parantTree]);
                    seteditPageTxt(pagedata[thisPage].PageTxt);
                    seteditPageIndex(pagedata[thisPage].PageIndex);
                    seteditPageLink(pagedata[thisPage].PageLink);
                    seteditPageType(pagedata[thisPage].PageType);
                    props.onChangeDragUrl(
                        pagedata[thisPage].iconBase64,
                        JSON.parse(JSON.stringify(pagedata[thisPage].moduleJson)),
                        `${pagedata[thisPage].PageTxt}&${pagedata[thisPage].PageIndex}&${pagedata[thisPage].PageName}&${pagedata[thisPage].id}&${pagedata[thisPage].PageType}`
                    );
                }
            }
        } else {
            seteditPageId(false);
            seteditPageName('');
            seteditPagePidName('');
            seteditPageTxt('');
            seteditPageIndex('');
            seteditPageLink('');
        }
    };

    const uploadPageprops = {
        name: 'file',
        showUploadList: false,
        customRequest: async ({ file, onSuccess, onError }) => {
            try {
                const fileData = await toBase64DataUrl(file);
                const res = await httpsend.getDataLocal('exportImport', {
                    fileName: file.name,
                    fileData,
                });
                if (res && res.code === 100) {
                    onSuccess(res);
                    return;
                }
                onError(new Error((res && res.msg) || t('itemBox.importFailed')));
            } catch (error) {
                onError(error);
            }
        },
        onChange: async (info) => {
            if (info.file.status === 'done') {
                if (info.file.response && info.file.response.code === 100) {
                    const importData = info.file.response.data;
                    const duplicateByTxt = !!(importData && importData.duplicateByTxt);
                    if (duplicateByTxt) {
                        message.warning(t('itemBox.duplicatePageSkipped'));
                        getImgData('page');
                        return;
                    }
                    const fallbackName = String(info.file.name || '').replace(/^.*[\\/]/, '');
                    const uploadedFileStem = fallbackName.replace(/\.[^/.]+$/, '');
                    const rawImportedTxt = typeof importData === 'string'
                        ? importData
                        : ((importData && importData.pageTxt) ? importData.pageTxt : fallbackName);
                    const importedTxtName = String(rawImportedTxt || fallbackName)
                        .replace(/\\/g, '/')
                        .split('/')
                        .pop();
                    const importedTxtStem = importedTxtName.replace(/\.txt$/i, '');
                    const pageNameFromPackage = uploadedFileStem
                        .replace(/\[[^\]]*]/g, '')
                        .replace(/\uFF3B[^\uFF3D]*\uFF3D/g, '')
                        .trim();
                    const importedPageName = pageNameFromPackage || importedTxtStem || `import_${Date.now()}`;
                    const packageIndexMatches = [...uploadedFileStem.matchAll(/\[([^\]]+)\]|\uFF3B([^\uFF3D]+)\uFF3D/g)];
                    let packagePageIndex = '';
                    packageIndexMatches.some((match) => {
                        const rawIndex = String(match[1] || match[2] || '').trim();
                        if (!rawIndex) return false;
                        const parsedIndex = parseInt(rawIndex, 10);
                        if (Number.isNaN(parsedIndex)) return false;
                        packagePageIndex = String(parsedIndex);
                        return true;
                    });

                    const pageListRes = await httpsend.getData('GetDmpageListKey', { ComboBox: 'all' });
                    let maxIndex = 0;
                    const collectMaxIndex = (items) => {
                        if (!Array.isArray(items)) return;
                        items.forEach((item) => {
                            const pageIndex = parseInt(item.PageIndex, 10);
                            if (!Number.isNaN(pageIndex) && pageIndex > maxIndex) {
                                maxIndex = pageIndex;
                            }
                            if (Array.isArray(item.children) && item.children.length > 0) {
                                collectMaxIndex(item.children);
                            }
                        });
                    };
                    if (pageListRes && pageListRes.code === 100) {
                        collectMaxIndex(pageListRes.data);
                    }

                    let duplicateByPageMeta = false;
                    if (pageListRes && pageListRes.code === 100) {
                        const targetName = String(importedPageName || '').trim().toLowerCase();
                        const targetTxt = normalizePageTxt(importedTxtStem || importedTxtName).toLowerCase();
                        collectExistingPages(pageListRes.data, (item) => {
                            if (duplicateByPageMeta) return;
                            const itemName = String(item.PageName || '').trim().toLowerCase();
                            const itemTxt = normalizePageTxt(item.PageTxt).toLowerCase();
                            if ((targetName && itemName && itemName === targetName) || (targetTxt && itemTxt && itemTxt === targetTxt)) {
                                duplicateByPageMeta = true;
                            }
                        });
                    }
                    if (duplicateByPageMeta) {
                        await httpsend.getDataLocal('imgData', { action: 'delpage', name: importedTxtStem || importedTxtName });
                        message.warning(t('itemBox.duplicatePageSkipped'));
                        getImgData('page');
                        return;
                    }

                    const createRes = await httpsend.getData('CreateDmpageKey', {
                        PageType: '1',
                        PageName: importedPageName,
                        pid: '0',
                        PageIndex: packagePageIndex || String(maxIndex + 1),
                        ProId: 0,
                        PageTop: -1,
                        PageTxt: importedTxtStem || importedTxtName,
                    });

                    if (createRes && createRes.code === 100) {
                        message.success(t('itemBox.importSuccess'));
                        getImgData('page');
                    } else if (isDuplicateCreateError(createRes)) {
                        await httpsend.getDataLocal('imgData', { action: 'delpage', name: importedTxtStem || importedTxtName });
                        message.warning(t('itemBox.duplicatePageSkipped'));
                        getImgData('page');
                    } else {
                        await httpsend.getDataLocal('imgData', { action: 'delpage', name: importedTxtStem || importedTxtName });
                        message.error((createRes && createRes.msg) || t('itemBox.importFailed'));
                    }
                } else {
                    message.error(info.file.response.msg);
                }
            } else if (info.file.status === 'error') {
                const reason = (info.file && info.file.error && info.file.error.message)
                    ? info.file.error.message
                    : `${info.file.name} ${t('itemBox.importFailed')}`;
                message.error(reason);
            }
        }
    };

    const exportPage = async () => {
        if (!editPageTxt) {
            message.warning(t('auto.k0512'));
            return;
        }

        let conres = await httpsend.getDataLocal('export', {
            pageName: editPageName,
            pageTxt: editPageTxt,
            pageIndex: editPageIndex
        });
        if (conres && conres.code && conres.code === 100) {
            const fileUrl = typeof conres.data === 'string'
                ? conres.data
                : (conres.data && conres.data.fileUrl) ? conres.data.fileUrl : '';
            if (!fileUrl) {
                message.error(t('http.requestFailed'));
                return;
            }

            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = `../${fileUrl.replace(/^\/+/, '')}`;
            const lowerUrl = fileUrl.toLowerCase();
            const fileExt = lowerUrl.endsWith('.zip') ? '.zip' : (lowerUrl.endsWith('.txt') ? '.txt' : '');
            if (fileExt !== '.zip') {
                message.warning(t('itemBox.exportNotZipWarning'));
            }
            a.download = `${editPageName}[${editPageIndex}]${fileExt}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else if (conres) {
            message.error(conres.msg);
        }
    };

    return (
        <>
        <div className="left">
            <ul>
                {nav.map((val, i) => (
                    <li key={i} onClick={() => changeSelectedNav(i)} className={`${selectedNav === i ? 'check' : ''}`}>
                        {val.icon}
                        <br />
                        {val.title}
                    </li>
                ))}
            </ul>
            <div>
                {selectedNav === 6 && (
                    <>
                        <div className="galleryToolbar uploadBtn">
                            <div className="galleryToolbarLeft">
                                <Upload {...uploadprops}>
                                    <Button type="primary">{t('common.upload')}</Button>
                                </Upload>
                            </div>
                            <div className="galleryToolbarRight">
                                <Button className="delBtn" type="primary" danger onClick={() => setshowDelbtn(1)} style={showDelbtn === 0 ? { display: 'block' } : { display: 'none' }}>{t('common.delete')}</Button>
                                <Button className="delBtn" danger onClick={() => setshowDelbtn(0)} style={showDelbtn === 1 ? { display: 'block' } : { display: 'none' }}>{t('common.done')}</Button>
                            </div>
                        </div>
                        <div className="galleryListOnly" style={{ marginTop: '42px' }} onMouseLeave={() => setHoverPreviewImg('')}>
                            {selectedData.map((v, index) => (
                                <div className="itmeOne" key={index}>
                                    <CloseCircleOutlined className="delOne" style={showDelbtn === 1 ? { display: 'block' } : { display: 'none' }} onClick={() => delThisImg(v.iconBase64, 'img')} />
                                    <img
                                        src={v.iconBase64}
                                        alt={JSON.stringify(v.moduleJson)}
                                        onMouseEnter={(e) => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setHoverPreviewImg(v.iconBase64);
                                            setHoverPreviewPos({ x: rect.right + 16, y: rect.top });
                                        }}
                                        onDragStart={(e) => {
                                            props.onChangeDragUrl(e.target.src, JSON.parse(e.target.alt));
                                        }}
                                        className={hoverPreviewImg === v.iconBase64 ? 'galleryThumb active' : 'galleryThumb'}
                                    />
                                </div>
                            ))}
                        </div>
                        {hoverPreviewImg && <div className="galleryHoverPreview" style={{ left: hoverPreviewPos.x, top: hoverPreviewPos.y }}>
                            <img src={hoverPreviewImg} alt="preview" className="galleryPreviewImg" />
                        </div>}
                    </>
                )}

                {selectedNav === 4 && (
                    <>
                        <div className="uploadBtn">
                            <Button className="delBtn" type="primary" danger onClick={() => setshowTplDelbtn(1)} style={showTplDelbtn === 0 ? { display: 'block' } : { display: 'none' }}>{t('common.delete')}</Button>
                            <Button className="delBtn" danger onClick={() => setshowTplDelbtn(0)} style={showTplDelbtn === 1 ? { display: 'block' } : { display: 'none' }}>{t('common.done')}</Button>
                        </div>
                        <div style={{ marginTop: '42px' }}>
                            {selectedData.map((v, index) => (
                                <div className="itmeOne" key={index}>
                                    <CloseCircleOutlined className="delOne" style={showTplDelbtn === 1 ? { display: 'block' } : { display: 'none' }} onClick={() => delThisImg(v.moduleName, 'tpl')} />
                                    <img
                                        src="Images/icon/tpl.png"
                                        alt={JSON.stringify(v.moduleJson)}
                                        className="galleryThumb"
                                        onDragStart={(e) => {
                                            props.onChangeDragUrl(e.target.src, JSON.parse(e.target.alt));
                                        }}
                                    />
                                    <div title={v.moduleName}>{v.moduleName}</div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {selectedNav === 0 && (
                    <>
                        <div className="uploadBtn">
                            {editPageId && <Button className="delBtn" type="primary" danger onClick={() => setIsdelModalOpen(true)}>{t('common.delete')}</Button>}
                            <Upload {...uploadPageprops}>
                                <Button type="primary">{t('common.import')}</Button>
                            </Upload>
                            {(editPageId && editPageTxt) && <Button type="primary" onClick={exportPage}>{t('common.export')}</Button>}
                            {editPageId && <Button type="primary" onClick={() => setshoweditPageBox(true)}>{t('common.settings')}</Button>}
                        </div>
                        <div style={{ marginTop: '62px' }}>
                            {selectedData.length > 0 && (
                                <Tree
                                    showLine
                                    showIcon
                                    onSelect={onTreeSelect}
                                    treeData={selectedData}
                                />
                            )}
                        </div>
                    </>
                )}

                {(selectedNav === 1 || selectedNav === 2 || selectedNav === 3 || selectedNav === 5) && selectedData.map((v, index) => (
                    <div className="itmeOne" key={index}>
                        <img
                            className="galleryThumb"
                            src={v.iconBase64}
                            alt={JSON.stringify(v.moduleJson)}
                            onDragStart={(e) => {
                                props.onChangeDragUrl(e.target.src, JSON.parse(e.target.alt));
                            }}
                        />
                        {v.moduleName && <div>{v.moduleName}</div>}
                    </div>
                ))}
            </div>
        </div>

        {/* 删除确认弹窗 - 移到 .left 外面避免被容器裁剪 */}
        <div className="layui-layer" style={isdelModalOpen ? { display: 'block' } : { display: 'none' }}>
            <div className="layui-layer-title">{t('common.reminder')}</div>
            <div className="layui-layer-content">{t('itemBox.deleteConfirmPrefix')}<span style={{ color: '#1E9FFF', fontSize: 18 }}>{editPageName}</span>{t('itemBox.deleteConfirmSuffix')}</div>
            <span className="layui-layer-setwin" onClick={() => setIsdelModalOpen(false)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button
                    type="primary"
                    onClick={async () => {
                        let res = await httpsend.getData('DelDmpageKey', {
                            id: editPageId
                        });
                        if (res) {
                            if (res.code === 100) {
                                let txtres = await httpsend.getDataLocal('imgData', { action: 'delpage', name: editPageTxt });
                                if (txtres.code === 100) {
                                    message.success(t('itemBox.deleteSuccess'));
                                    getImgData('page');
                                } else {
                                    message.error(t('itemBox.removePageFileFailed'));
                                }
                            } else {
                                message.error(t('itemBox.deleteFailed'));
                            }
                        }
                        setIsdelModalOpen(false);
                    }}
                >
                    {t('common.confirm')}
                </Button>
            </div>
        </div>

        {/* 编辑页面弹窗 - 移到 .left 外面避免被容器裁剪 */}
        <div className="layui-layer" id="editPage" style={showeditPageBox ? { display: 'block' } : { display: 'none' }} key={editPageId}>
            <div className="layui-layer-title">{t('itemBox.editPage')}</div>
            <div className="layui-layer-content">
                <div>
                    <label>{t('itemBox.pageName')}</label>
                    <input style={{ width: '167px' }} type="text" onChange={(e) => seteditPageName(e.target.value)} defaultValue={editPageName} />
                </div>
                <div>
                    <label>{t('itemBox.parentPage')}</label>
                    <Cascader options={savePagePidSel} defaultValue={editPagePidName} onChange={(val) => seteditPagePid(val[val.length - 1])} style={{ width: '167px' }} changeOnSelect />
                </div>
                <div>
                    <label>{t('itemBox.pageOrder')}</label>
                    <input style={{ width: '167px' }} type="number" onChange={(e) => seteditPageIndex(e.target.value)} defaultValue={editPageIndex} />
                </div>
                {editPageType === '3' && (
                    <div>
                        <label>{t('itemBox.jumpUrl')}</label>
                        <input style={{ width: '167px' }} type="text" onChange={(e) => seteditPageLink(e.target.value)} defaultValue={editPageLink} />
                    </div>
                )}
                <div>
                    <label>{t('itemBox.homepageDisplay')}</label>
                    <select style={{ width: '167px' }} onChange={(e) => seteditPageTop(e.target.value)}>
                        <option value="1" selected={editPageTop === '1'}>{t('common.yes')}</option>
                        <option value="-1" selected={editPageTop === '-1'}>{t('common.no')}</option>
                    </select>
                </div>
            </div>
            <span className="layui-layer-setwin" onClick={() => setshoweditPageBox(false)}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button
                    type="primary"
                    onClick={async () => {
                        let params = {
                            id: editPageId,
                            PageName: editPageName,
                            PageIndex: editPageIndex,
                            pid: editPagePid,
                            PageTop: editPageTop
                        };
                        if (editPageType === '3') {
                            params.PageTxt = editPageLink;
                        }
                        let res = await httpsend.getData('ChangeDmpageKey', params);
                        if (res && res.code === 100) {
                            message.success(t('itemBox.updateSuccess'));
                            getImgData('page');
                        } else {
                            message.error(t('itemBox.updateFailed'));
                        }
                        setshoweditPageBox(false);
                        seteditPageTop('-1');
                    }}
                >
                    {t('common.confirm')}
                </Button>
            </div>
        </div>
        </>
    );
}

export default ItemBox;
