import React, { memo, useState, useEffect } from 'react';
import { Close } from '@mui/icons-material';
import { Button } from 'antd';
import { t } from '../i18n';
// import MyImages from './Data/MyImages';
import httpsend from '../Assets/httpsend';

const ElementSvg = memo((props) => {

    let attrList = [];// Comment translated to English.
    const [showImgBox, setshowImgBox] = useState(0);
    const [imgColor, setimgColor] = useState((props.imgUrl && props.imgUrl.indexOf('#')>-1) ? props.imgUrl:'#ffffff');// Comment translated to English.
    const [imgUrl, setimgUrl] = useState((props.imgUrl && props.imgUrl.indexOf('#')===-1) ? props.imgUrl:null);// Comment translated to English.
    const [MyImages, setMyImages] = useState([]);// Comment translated to English.
    const [alarmCatch, setalarmCatch] = useState(props.alarmCatch ? props.alarmCatch:'1');// Comment translated to English.

    useEffect(() => {// Comment translated to English.
        getImgData('upload')
    }, []);

    // Comment translated to English.
    const getImgData = async (type) => {
        let res = await httpsend.getDataLocal('imgData', { action: type });
        let imgData = [];
        if (res) {
            res.data.forEach(element => {
                let imgOne = { "img": element.imgUrl }
                imgData.push(imgOne);
            });
        }
        setMyImages(imgData);
    }

    // Comment translated to English.
    const handleValChange = (e) => {
        setimgColor(e.target.value)
        setimgUrl(null);
        props.onChange(e.target.value);
    }
    // Comment translated to English.
    const setimgChange = (img) => {
        setimgColor('#ffffff');
        setimgUrl(img);
        props.onChange(img);
    }
    // Comment translated to English.
    const handleSelValChange = (e) => {
        setalarmCatch(e.target.value)
        props.onSelChange(e.target.value);
    }
    // Comment translated to English.
    attrList.push(<div className="attrTitle" key='000'>{t('auto.k0195')}</div>)
    attrList.push(<div className="attrBox" key='001'>
        <label>{t('auto.k0194')}</label>
        <img src={imgUrl ? imgUrl : 'Images/icon/error.jpg'}
            alt={t('auto.k0194')}
            onClick={() => setshowImgBox(1)}
        />
    </div>)
    attrList.push(<div className="attrBox" key='002'>
        <label>{t('auto.k0196')}</label>
        <input
            type="color"
            value={imgColor}
            onChange={handleValChange}
        />
    </div>)
    attrList.push(<div className="attrTitle" key='004'>{t('auto.k0197')}</div>)
    attrList.push(<div className="attrBox" key='005'>
        <label>{t('auto.k0198')}</label>
        <select
            defaultValue={alarmCatch}
            onChange={handleSelValChange}>
            <option value='1'>{t('auto.k0199')}</option>
            <option value='2'>{t('auto.k0200')}</option>
        </select>
    </div>)
    // Comment translated to English.
    attrList.push(
        <div className="layui-layer" key='003' id="chooseImg" style={showImgBox === 1 ? { 'display': 'block' } : { 'display': 'none' }}>
            <div className="layui-layer-title">{t('auto.k0201')}</div>
            <div className="layui-layer-content">
                {
                    MyImages.map((imgs, n) => {
                        let unikey = '003' + n;
                        return (<img src={imgs.img} key={unikey} onClick={(e) => setimgChange(imgs.img, e)} alt={imgs.img} />)
                    })
                }
            </div>
            <span className="layui-layer-setwin" onClick={() => { setshowImgBox(0); }}>
                <Close />
            </span>
            <div className="layui-layer-btn">
                <Button type="primary" onClick={async () => {
                    setshowImgBox(0);
                }}>{t('auto.k0202')}</Button>
            </div>
        </div>
    )

    return attrList;
})
export default ElementSvg;