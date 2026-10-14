"""Собирает команду «Разложить по полочкам» для приложения «Команды» (Shortcuts) в виде plist.

Одна команда делает всё за один запуск. С сайта в буфер обмена приходит раскладка
{"убрать": ["IMG_1234", ...], "создать": {"Альбом": [...]}, "добавить": {"Альбом": [...]}}:
1. «убрать»: снимки убираются из альбома, который iPhone спросит один раз (из «Фото» ничего не удаляется);
2. «создать»: для каждого альбома находит снимки по имени и создаёт альбом;
3. «добавить»: докладывает снимки в альбомы, созданные раньше.
Использование: python3 shortcut/build.py <файл.plist>
"""
import plistlib
import sys
import uuid

OBJ = '￼'


def uid():
    return str(uuid.uuid4()).upper()


def output(action_uuid, name):
    return {'Value': {'OutputName': name, 'OutputUUID': action_uuid, 'Type': 'ActionOutput'},
            'WFSerializationType': 'WFTextTokenAttachment'}


def variable(name):
    return {'Value': {'Type': 'Variable', 'VariableName': name},
            'WFSerializationType': 'WFTextTokenAttachment'}


def text_with(name):
    return {'Value': {'string': OBJ, 'attachmentsByRange': {'{0, 1}': {'Type': 'Variable', 'VariableName': name}}},
            'WFSerializationType': 'WFTextTokenString'}


def action(identifier, **params):
    return {'WFWorkflowActionIdentifier': f'is.workflow.actions.{identifier}', 'WFWorkflowActionParameters': params}


def find_photo(name_variable):
    """«Найти фото», где имя начинается с имени снимка с сайта; не больше одного."""
    return action('filter.photos', UUID=uid(), WFContentItemLimitEnabled=True, WFContentItemLimitNumber=1.0,
                  WFContentItemFilter={
                      'Value': {
                          'WFActionParameterFilterPrefix': 1,
                          'WFContentPredicateBoundedDate': False,
                          'WFActionParameterFilterTemplates': [{
                              'Operator': 8,  # «begins with»: имя в «Фото» может быть с расширением
                              'Property': 'Name',
                              'Removable': True,
                              'Values': {'Unit': 4, 'String': text_with(name_variable)},
                          }],
                      },
                      'WFSerializationType': 'WFContentPredicateTableTemplate',
                  })


def ask():
    """Поле «Спрашивать каждый раз» (Ask Each Time)."""
    return {'Value': {'string': OBJ, 'attachmentsByRange': {'{0, 1}': {'Type': 'Ask', 'VariableName': 'Ask'}}},
            'WFSerializationType': 'WFTextTokenString'}


def section(key, dictionary, put):
    """Для раздела раскладки «создать» или «добавить»: по каждому альбому найти снимки и положить их."""
    part, keys, values = uid(), uid(), uid()
    outer, inner, inner_end = uid(), uid(), uid()
    return [
        action('getvalueforkey', UUID=part, WFGetDictionaryValueType='Value', WFDictionaryKey=key,
               WFInput=output(dictionary, 'Dictionary')),
        # Названия альбомов: ключи раздела
        action('getvalueforkey', UUID=keys, WFGetDictionaryValueType='All Keys',
               WFInput=output(part, 'Dictionary Value')),
        action('repeat.each', GroupingIdentifier=outer, WFControlFlowMode=0,
               WFInput=output(keys, 'Dictionary Value')),
        # Имена снимков этого альбома
        action('getvalueforkey', UUID=values, WFGetDictionaryValueType='Value',
               WFDictionaryKey=text_with('Repeat Item'), WFInput=output(part, 'Dictionary Value')),
        action('repeat.each', GroupingIdentifier=inner, WFControlFlowMode=0,
               WFInput=output(values, 'Dictionary Value')),
        find_photo('Repeat Item 2'),
        action('repeat.each', GroupingIdentifier=inner, WFControlFlowMode=2, UUID=inner_end),
        put(output(inner_end, 'Repeat Results')),
        action('repeat.each', GroupingIdentifier=outer, WFControlFlowMode=2, UUID=uid()),
    ]


def build():
    clipboard, dictionary, remove = uid(), uid(), uid()
    loop, loop_end, check = uid(), uid(), uid()
    found = output(loop_end, 'Repeat Results')
    actions = [
        action('getclipboard', UUID=clipboard),
        action('detect.dictionary', UUID=dictionary, WFInput=output(clipboard, 'Clipboard')),
        # 1. Убрать снимки из старого альбома. Альбом iPhone спросит один раз; сами снимки остаются в «Фото».
        action('getvalueforkey', UUID=remove, WFGetDictionaryValueType='Value', WFDictionaryKey='убрать',
               WFInput=output(dictionary, 'Dictionary')),
        action('repeat.each', GroupingIdentifier=loop, WFControlFlowMode=0,
               WFInput=output(remove, 'Dictionary Value')),
        find_photo('Repeat Item'),
        action('repeat.each', GroupingIdentifier=loop, WFControlFlowMode=2, UUID=loop_end),
        action('conditional', GroupingIdentifier=check, WFControlFlowMode=0, WFConditions={
            'Value': {
                'WFActionParameterFilterPrefix': -1,
                'WFActionParameterFilterTemplates': [{
                    'WFCondition': 100,  # «has any value»
                    'WFInput': {'Type': 'Variable', 'Variable': found},
                }],
            },
            'WFSerializationType': 'WFContentPredicateTableTemplate',
        }),
        action('removefromalbum', WFInput=found, WFRemoveAlbumSelectedGroup=ask()),
        action('conditional', GroupingIdentifier=check, WFControlFlowMode=2, UUID=uid()),
        # 2. Новые альбомы
        *section('создать', dictionary,
                 lambda photos: action('photos.createalbum', AlbumName=text_with('Repeat Item'), WFInput=photos)),
        # 3. Доложить в альбомы, созданные раньше
        *section('добавить', dictionary,
                 lambda photos: action('savetocameraroll', WFCameraRollSelectedGroup=text_with('Repeat Item'),
                                       WFInput=photos)),
    ]
    return {
        'WFWorkflowClientVersion': '2302.0.4',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
        'WFWorkflowActions': actions,
        'WFWorkflowInputContentItemClasses': [],
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowImportQuestions': [],
        'WFWorkflowTypes': [],
        'WFQuickActionSurfaces': [],
        'WFWorkflowHasOutputFallback': False,
        'WFWorkflowHasShortcutInputVariables': False,
    }


if __name__ == '__main__':
    with open(sys.argv[1], 'wb') as f:
        plistlib.dump(build(), f, fmt=plistlib.FMT_XML)
